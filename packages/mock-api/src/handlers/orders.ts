import {
  type CreateOrderBody,
  type OrderListStatus,
  type SubOrderInput,
  type UpdateOrderBody,
  createOrderBodySchema,
  formatOrderNumber,
  lineRate,
  orderListQuerySchema,
  subOrderSuffix,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, type IssueDetail, validationError } from '../errors.ts';
import { type OrderCtx, findOrder, orderCtx, toOrder, toSummary, visibleSubOrders } from '../order-views.ts';
import { nextNumber, orderMath } from '../orders-math.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, OrderLineRec, OrderRec, ProductRec, SubOrderRec } from '../store.ts';
import { type Authed, authed, logActivity, newId } from '../views.ts';
import { createDraftRec, deleteDraftIfVisible, toDraft } from './drafts.ts';

type OrderInput = Omit<CreateOrderBody, 'draftId'> | UpdateOrderBody;

/**
 * Checks everything an order points at, before anything is written (§5.3 assignment guards that
 * apply at booking): parties of the right type and active, addresses belonging to the customer,
 * companies of this tenant and active, products known, active and made by the line's company.
 * 422 for wrong references (collected together), then 409 for business refusals.
 */
export function validateOrderRefs(state: MockState, a: Authed, body: OrderInput): void {
  const tenantId = a.user.tenantId;
  const issues: IssueDetail[] = [];
  const party = (id: string | null, type: 'customer' | 'broker', path: string) => {
    if (id === null) return undefined;
    const p = state.parties.find((x) => x.id === id && x.tenantId === tenantId);
    if (!p || p.type !== type || !p.active) {
      issues.push({ path: [path], message: `Choose an active ${type}` });
      return undefined;
    }
    return p;
  };
  const customer = party(body.customerId, 'customer', 'customerId');
  party(body.brokerId, 'broker', 'brokerId');
  if (customer) {
    const has = (id: string | null, kind: 'bill_to' | 'ship_to') =>
      id === null || customer.addresses.some((x) => x.id === id && x.kind === kind);
    if (!has(body.billToId, 'bill_to')) issues.push({ path: ['billToId'], message: "Choose one of the customer's bill-to addresses" });
    if (!has(body.shipToId, 'ship_to')) issues.push({ path: ['shipToId'], message: "Choose one of the customer's sites" });
  }

  const refusals: ApiError[] = [];
  body.subOrders.forEach((s, si) => {
    const company = state.companies.find((c) => c.id === s.companyId && c.tenantId === tenantId);
    if (!company) {
      issues.push({ path: ['subOrders', si, 'companyId'], message: 'Unknown company' });
      return;
    }
    if (!company.active) refusals.push(new ApiError(409, 'COMPANY_INACTIVE', { subOrderIndex: si }));
    s.lines.forEach((l, li) => {
      const product = state.products.find((p) => p.id === l.productId && p.tenantId === tenantId);
      if (!product) {
        issues.push({ path: ['subOrders', si, 'lines', li, 'productId'], message: 'Unknown product' });
      } else if (!product.active && l.id === undefined) {
        issues.push({ path: ['subOrders', si, 'lines', li, 'productId'], message: 'This product is inactive' });
      } else if (!product.companyIds.includes(company.id)) {
        refusals.push(new ApiError(409, 'PRODUCT_NOT_FOR_COMPANY', { subOrderIndex: si, lineIndex: li }));
      }
    });
  });
  if (issues.length > 0) throw validationError(issues);
  const first = refusals[0];
  if (first) throw first;
}

/** A line record priced from the body (rate snapshotted with the product's current conversion). */
export function newLineRec(
  state: MockState,
  body: OrderInput,
  sub: SubOrderRec,
  l: SubOrderInput['lines'][number],
  at: string,
): OrderLineRec {
  const product = state.products.find((p) => p.id === l.productId) as ProductRec;
  const { rate, rateEdited } = lineRate({
    method: body.pricingMethod,
    basicRate: body.basicRate,
    conversionPerMt: product.conversionPerMt,
    typedRate: l.typedRate,
  });
  return {
    id: newId(),
    tenantId: sub.tenantId,
    subOrderId: sub.id,
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

export function newSubOrderRec(order: OrderRec, companyId: string, suffix: string, at: string): SubOrderRec {
  return {
    id: newId(),
    tenantId: order.tenantId,
    orderId: order.id,
    companyId,
    suffix,
    closeKind: null,
    closeReason: null,
    closeNote: null,
    closedAt: null,
    closedBy: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/** The create body that re-books an existing order (used by Duplicate). */
function bodyFrom(state: MockState, order: OrderRec): Record<string, unknown> {
  const math = orderMath(state);
  return {
    type: order.type,
    customerId: order.customerId,
    brokerId: order.brokerId,
    commissionPerMt: order.commissionPerMtSnapshot,
    billToId: order.billToId,
    shipToId: order.shipToId,
    pricingMethod: order.pricingMethod,
    basicRate: order.basicRate,
    subOrders: math.subOrdersOf(order.id).map((s) => ({
      companyId: s.companyId,
      lines: math.linesOf(s.id).map((l) => ({
        productId: l.productId,
        length: { ...l.length },
        orderedKg: l.orderedKg,
        typedRate: order.pricingMethod === 'direct' || l.rateEdited ? l.rate : null,
        overpricePerMt: l.overpricePerMt,
      })),
    })),
    notify: { ...order.notify },
  };
}

const digits = (s: string) => s.replace(/\D/g, '');

function matches(c: OrderCtx, o: OrderRec, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  if (o.number.toLowerCase().includes(needle)) return true;
  const d = digits(needle);
  if (d.length >= 3 && digits(o.number).includes(d)) return true;
  const names = [o.customerId, o.brokerId].map((id) => (id ? c.partyById.get(id)?.name ?? '' : ''));
  return names.some((n) => n.toLowerCase().includes(needle));
}

interface Cursor {
  at: string;
  id: string;
}
const encodeCursor = (o: OrderRec) => `${o.createdAt}|${o.id}`;
function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const [at, id] = raw.split('|');
  if (!at || !id) throw validationError([{ path: ['cursor'], message: 'Invalid cursor' }]);
  return { at, id };
}
const cmpKey = (o: { createdAt: string; id: string }, c: Cursor) =>
  o.createdAt === c.at ? (o.id < c.id ? -1 : o.id > c.id ? 1 : 0) : o.createdAt < c.at ? -1 : 1;

export const orderRoutes: RouteDef[] = [
  route('POST', '/v1/orders', {
    action: 'order.create',
    idempotent: true,
    transactional: true,
    body: createOrderBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      validateOrderRefs(state, a, body);
      const at = toIso(now);
      const seq = nextNumber(state, a.user.tenantId, 'order', now);
      const order: OrderRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        number: formatOrderNumber(a.tenant.settings.orderNumberFormat, now, seq),
        type: body.type,
        customerId: body.customerId,
        brokerId: body.brokerId,
        commissionPerMtSnapshot: body.brokerId !== null ? body.commissionPerMt : null,
        billToId: body.billToId,
        shipToId: body.shipToId,
        pricingMethod: body.pricingMethod,
        basicRate: body.pricingMethod === 'basic_conversion' ? body.basicRate : null,
        notify: { ...body.notify },
        suffixesUsed: body.subOrders.length,
        createdBy: a.user.id,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.orders.push(order);
      body.subOrders.forEach((s, si) => {
        const sub = newSubOrderRec(order, s.companyId, subOrderSuffix(si), at);
        state.subOrders.push(sub);
        for (const l of s.lines) state.orderLines.push(newLineRec(state, body, sub, l, at));
      });
      if (body.draftId !== null) deleteDraftIfVisible(state, a, body.draftId);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: 'order.created',
        meta: { number: order.number },
      });
      return { status: 201, body: toOrder(orderCtx(state, orderMath(state), a, now), order) };
    },
  }),

  route('GET', '/v1/orders', {
    action: 'order.view',
    query: orderListQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, query } = ctx;
      const c = orderCtx(state, orderMath(state), a, now);
      if (query.companyId !== undefined && !c.visibleCompanyIds.has(query.companyId)) {
        return { body: { items: [], counts: emptyCounts(), nextCursor: null } };
      }
      const rows = state.orders
        .filter((o) => o.tenantId === a.user.tenantId)
        .filter((o) => {
          const subs = visibleSubOrders(c, o);
          return subs.length > 0 && (query.companyId === undefined || subs.some((s) => s.companyId === query.companyId));
        })
        .filter((o) => query.q === undefined || matches(c, o, query.q))
        .map((o) => ({ o, summary: toSummary(c, o, query.companyId) }))
        .filter((r) => query.aged === undefined || r.summary.isAged === query.aged);

      const counts = emptyCounts();
      for (const r of rows) {
        counts.all += 1;
        if (r.summary.status !== 'draft') counts[r.summary.status] += 1;
      }
      const dir = query.sort === 'newest' ? -1 : 1;
      const cursor = decodeCursor(query.cursor);
      const sorted = rows
        .filter((r) => query.status === 'all' || r.summary.status === query.status)
        .sort((x, y) => dir * (cmpKey(x.o, { at: y.o.createdAt, id: y.o.id })))
        .filter((r) => cursor === null || dir * cmpKey(r.o, cursor) > 0);
      const page = sorted.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        body: {
          items: page.map((r) => r.summary),
          counts,
          nextCursor: sorted.length > page.length && last ? encodeCursor(last.o) : null,
        },
      };
    },
  }),

  route('GET', '/v1/orders/:id', {
    action: 'order.view',
    async handler(ctx) {
      const a = authed(ctx);
      const c = orderCtx(ctx.state, orderMath(ctx.state), a, ctx.now);
      return { body: toOrder(c, findOrder(c, ctx.params.id)) };
    },
  }),

  route('POST', '/v1/orders/:id/duplicate', {
    action: 'order.duplicate',
    idempotent: true,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      const c = orderCtx(state, orderMath(state), a, now);
      const order = findOrder(c, ctx.params.id);
      const draft = createDraftRec(state, a, bodyFrom(state, order), now);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: 'order.duplicated',
        meta: { draftId: draft.id },
      });
      return { status: 201, body: toDraft(state, draft) };
    },
  }),
];

function emptyCounts(): Record<OrderListStatus, number> {
  return { all: 0, open: 0, partly_dispatched: 0, completed: 0, short_closed: 0, cancelled: 0 };
}
