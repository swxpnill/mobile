import {
  type CreateOrderBody,
  type SubOrderInput,
  type UpdateOrderBody,
  financialYear,
  formatOrderNumber,
  lineRate,
  subOrderSuffix,
} from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { asc } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { pgError } from '../db/pg-error.ts';
import { companies, orderLines, orders, subOrders } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { AppError, type IssueDetail } from '../http/errors.ts';
import type { OrderGraph } from '../views/orderGraph.ts';
import type { ProductGraph } from '../views/products.ts';
import { logActivity } from './activity.ts';
import { deleteDraftIfVisible } from './drafts.ts';
import { anyId } from './orderGraph.ts';
import { afterOrderCreated } from './orderEffects.ts';
import { ORDER_SERIES, nextNumber } from './numbering.ts';
import { partyRefIssues } from './parties.ts';
import { PRODUCT_LINE_FK, loadProducts } from './products.ts';
import { loadSettings } from './settings.ts';

/** What an order write books: the create body without its draft, or an edit body (Task 6). */
export type OrderInput = Omit<CreateOrderBody, 'draftId'> | UpdateOrderBody;

/** The products an order input names, as `validateOrderRefs` checked them (all present and allowed). */
export type CheckedProducts = ReadonlyMap<string, ProductGraph>;

/**
 * Checks everything an order points at before anything is written, as the mock's
 * `validateOrderRefs` (§5.3 guards at booking): parties of the right type and active, addresses
 * belonging to the customer, companies of this tenant and active, products known, active (for a
 * new line) and made by the line's company. 422 for wrong references, collected together; then
 * the first 409 business refusal. Returns the products, for pricing.
 */
export async function validateOrderRefs(tx: Tx, body: OrderInput): Promise<CheckedProducts> {
  const issues: IssueDetail[] = await partyRefIssues(tx, body);
  const companyIds = [...new Set(body.subOrders.map((s) => s.companyId))];
  // FOR SHARE, held to commit: a deactivation (which locks the company FOR UPDATE before counting
  // its open sub-orders) either ran first, and this read sees active = false, or waits for this
  // order and then counts it. Lock order across the API: company rows before order rows.
  const companyRows = await tx
    .select({ id: companies.id, active: companies.active })
    .from(companies)
    .where(anyId(companies.id, companyIds))
    .orderBy(asc(companies.id))
    .for('share');
  const companyById = new Map(companyRows.map((c) => [c.id, c]));
  const products = await loadProducts(tx, body.subOrders.flatMap((s) => s.lines.map((l) => l.productId)));

  const refusals: AppError[] = [];
  body.subOrders.forEach((s, si) => {
    const company = companyById.get(s.companyId);
    if (!company) {
      issues.push({ path: ['subOrders', si, 'companyId'], message: 'Unknown company' });
      return;
    }
    if (!company.active) refusals.push(new AppError(409, 'COMPANY_INACTIVE', { subOrderIndex: si }));
    s.lines.forEach((l, li) => {
      const product = products.get(l.productId);
      if (!product) {
        issues.push({ path: ['subOrders', si, 'lines', li, 'productId'], message: 'Unknown product' });
      } else if (!product.active && l.id === undefined) {
        issues.push({ path: ['subOrders', si, 'lines', li, 'productId'], message: 'This product is inactive' });
      } else if (!product.companyIds.includes(company.id)) {
        refusals.push(new AppError(409, 'PRODUCT_NOT_FOR_COMPANY', { subOrderIndex: si, lineIndex: li }));
      }
    });
  });
  if (issues.length > 0) throw new AppError(422, 'VALIDATION', issues);
  const first = refusals[0];
  if (first) throw first;
  return products;
}

/**
 * A new line's row, priced from the body with the product's current conversion (snapshotted),
 * through the shared `lineRate` rule. `position` places it after the sub-order's existing lines.
 */
export function newLineRow(
  body: Pick<OrderInput, 'pricingMethod' | 'basicRate'>,
  products: CheckedProducts,
  sub: { id: string; tenantId: string },
  l: SubOrderInput['lines'][number],
  position: number,
  at: Date,
): typeof orderLines.$inferInsert {
  const product = products.get(l.productId);
  if (!product) throw new Error(`newLineRow: product ${l.productId} was not checked`);
  const { rate, rateEdited } = lineRate({
    method: body.pricingMethod,
    basicRate: body.basicRate,
    conversionPerMt: product.conversionPerMt,
    typedRate: l.typedRate,
  });
  return {
    id: uuidv7(),
    tenantId: sub.tenantId,
    subOrderId: sub.id,
    position,
    productId: product.id,
    length: { ...l.length },
    orderedKg: l.orderedKg,
    basicRateSnapshot: body.pricingMethod === 'basic_conversion' ? body.basicRate : null,
    conversionSnapshot: product.conversionPerMt,
    rate,
    rateEdited,
    overpricePerMt: l.overpricePerMt,
    closedKg: 0,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/** A new sub-order's row (suffix handed out by the caller from `suffixes_used`). */
export function newSubOrderRow(
  order: { id: string; tenantId: string },
  companyId: string,
  suffix: string,
  at: Date,
): typeof subOrders.$inferInsert & { id: string } {
  return {
    id: uuidv7(),
    tenantId: order.tenantId,
    orderId: order.id,
    companyId,
    suffix,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Foreign keys an order write can meet when a referenced address or product went away after
 * `validateOrderRefs` looked (a party PATCH dropping the address, a product DELETE, committed while
 * the insert waited on their row).
 */
const LATE_REFERENCE_FKS: ReadonlySet<string> = new Set(['orders_bill_to_fk', 'orders_ship_to_fk', PRODUCT_LINE_FK]);

/**
 * Runs an order's inserts in a savepoint. When one of `LATE_REFERENCE_FKS` refuses them, the
 * references are checked again (the transaction is usable after the savepoint's rollback), which
 * now reports the vanished address or product as the same 422 with the same path and message.
 */
export async function withLateReferenceCheck<T>(tx: Tx, body: OrderInput, write: (sp: Tx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction(write);
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23503' && pg.constraint !== undefined && LATE_REFERENCE_FKS.has(pg.constraint)) {
      await validateOrderRefs(tx, body);
    }
    throw e;
  }
}

/**
 * A unique violation on (tenant_id, number) becomes 409 ORDER_NUMBER_TAKEN: a free-text
 * `orderNumberFormat` without YYMM repeats last financial year's numbers once the series resets.
 */
async function withOrderNumberUniqueness<T>(number: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === 'orders_tenant_number_key') {
      throw new AppError(409, 'ORDER_NUMBER_TAKEN', { number });
    }
    throw e;
  }
}

/**
 * Books an order (`POST /v1/orders`; Task 5's draft submit uses it too): checks the references,
 * takes the next number of the IST financial year under the series row lock, writes the order,
 * its sub-orders (A, B, … in body order) and priced lines, consumes the draft, logs the activity.
 * Returns the new order's id. Everything runs in the request's transaction.
 */
export async function createOrder(
  tx: Tx,
  ctx: { user: AuthedUser; now: number },
  body: CreateOrderBody,
): Promise<string> {
  const { user, now } = ctx;
  const products = await validateOrderRefs(tx, body);
  const settings = await loadSettings(tx, user.tenantId);
  const seq = await nextNumber(tx, ORDER_SERIES, financialYear(now), now);
  const at = new Date(now);
  const id = uuidv7();
  const number = formatOrderNumber(settings.orderNumberFormat, now, seq);
  const order = { id, tenantId: user.tenantId };
  const subs = body.subOrders.map((s, si) => ({ input: s, row: newSubOrderRow(order, s.companyId, subOrderSuffix(si), at) }));
  await withLateReferenceCheck(tx, body, async (sp) => {
    await withOrderNumberUniqueness(number, () => sp.insert(orders).values({
      id,
      tenantId: user.tenantId,
      number,
      type: body.type,
      customerId: body.customerId,
      brokerId: body.brokerId,
      commissionPerMtSnapshot: body.brokerId !== null ? body.commissionPerMt : null,
      billToId: body.billToId,
      shipToId: body.shipToId,
      pricingMethod: body.pricingMethod,
      basicRate: body.pricingMethod === 'basic_conversion' ? body.basicRate : null,
      notifyCustomer: body.notify.customer,
      notifyBroker: body.notify.broker,
      suffixesUsed: body.subOrders.length,
      createdBy: user.id,
      version: 1,
      createdAt: at,
      updatedAt: at,
    }));
    await sp.insert(subOrders).values(subs.map((s) => s.row));
    await sp
      .insert(orderLines)
      .values(subs.flatMap((s) => s.input.lines.map((l, position) => newLineRow(body, products, s.row, l, position, at))));
  });
  if (body.draftId !== null) await deleteDraftIfVisible(tx, user, body.draftId);
  await logActivity(tx, user, now, { entityType: 'order', entityId: id, action: 'order.created', meta: { number }, orderId: id });
  await afterOrderCreated(tx, ctx, id);
  return id;
}

/** The create body that re-books an existing order (Duplicate), from every sub-order, as the mock's `bodyFrom`. */
export function duplicatePayload(g: OrderGraph): Record<string, unknown> {
  const o = g.order;
  return {
    type: o.type,
    customerId: o.customerId,
    brokerId: o.brokerId,
    commissionPerMt: o.commissionPerMtSnapshot,
    billToId: o.billToId,
    shipToId: o.shipToId,
    pricingMethod: o.pricingMethod,
    basicRate: o.basicRate,
    subOrders: g.subOrders.map((s) => ({
      companyId: s.sub.companyId,
      lines: s.lines.map((l) => ({
        productId: l.productId,
        length: { ...l.length },
        orderedKg: l.orderedKg,
        typedRate: o.pricingMethod === 'direct' || l.rateEdited ? l.rate : null,
        overpricePerMt: l.overpricePerMt,
      })),
    })),
    notify: { customer: o.notifyCustomer, broker: o.notifyBroker },
  };
}
