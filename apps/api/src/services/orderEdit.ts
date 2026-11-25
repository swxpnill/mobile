import {
  type EditLineDesired,
  type EditLineExisting,
  type EditPlan,
  type Length,
  type PlantScope,
  type UpdateOrderBody,
  isTerminal,
  lineRate,
  planOrderEdit,
  subOrderSuffix,
} from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { orderLines, orders, subOrders } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { AppError } from '../http/errors.ts';
import { type LineRow, type SubOrderGraph, graphMath } from '../views/orderGraph.ts';
import { logActivity } from './activity.ts';
import { afterTrucksRemoved } from './orderEffects.ts';
import { findOrder } from './orderGraph.ts';
import { bumped, lockOrderTree, pruneOrderTree } from './orderTree.ts';
import { newLineRow, newSubOrderRow, validateOrderRefs, withLateReferenceCheck } from './orders.ts';

export interface OrderWriteCtx {
  user: AuthedUser;
  scope: PlantScope;
  now: number;
}

/** What a line is: product and length together ("productId|12m"), as the edit rules compare it. */
export const productKey = (productId: string, length: Length) => `${productId}|${length.value}${length.unit}`;

const sameLength = (a: Length, b: Length) => a.value === b.value && a.unit === b.unit;

/**
 * `PATCH /v1/orders/:id`, as the mock: the header is replaced; each body sub-order matches an
 * existing one by id, else by company, else is new (the next never-used suffix); each body line
 * with a known id updates that line (version bumped only when something changed), one without an
 * id is added; lines and sub-orders left out are removed. The shared `planOrderEdit` rule decides
 * what may change (BELOW_DISPATCHED, LINE_RATE_LOCKED, LINE_HAS_DISPATCHES, ORDER_LOCKED, …);
 * `BELOW_RESERVED` comes back as warnings.
 *
 * Locks (see `orderLifecycle.ts`): the body's companies FOR SHARE (`validateOrderRefs`), then the
 * order tree. The version is checked before the reference checks (the mock's error order) and
 * again under the order lock, where a write that committed meanwhile shows.
 */
export async function editOrder(
  tx: Tx,
  c: OrderWriteCtx,
  orderId: string | undefined,
  body: UpdateOrderBody,
): Promise<{ orderId: string; warnings: EditPlan['warnings'] }> {
  const { graph: seen } = await findOrder(tx, c.user, c.scope, c.now, orderId);
  if (body.version !== seen.order.version) throw new AppError(409, 'STALE');
  const products = await validateOrderRefs(tx, body);
  const g = await lockOrderTree(tx, seen.order.id, { mode: 'no key update', trucks: true });
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.order.version !== body.version) throw new AppError(409, 'STALE');

  const m = graphMath(g);
  const terminal = (s: SubOrderGraph) => isTerminal(m.subOrderStatus(s));
  const subs = g.subOrders;
  const subById = new Map(subs.map((s) => [s.sub.id, s]));
  const lineById = new Map(subs.flatMap((s) => s.lines.map((l) => [l.id, { l, s }] as const)));

  // Match each body sub-order to an existing one (by id, else by company) or mark it new.
  const targets = body.subOrders.map((bs, si) => {
    const s = (bs.id !== undefined ? subById.get(bs.id) : undefined) ?? subs.find((x) => x.sub.companyId === bs.companyId);
    if (s && s.sub.companyId !== bs.companyId) {
      throw new AppError(422, 'VALIDATION', [{ path: ['subOrders', si, 'companyId'], message: "A sub-order's company can't change" }]);
    }
    return s;
  });

  const existing: EditLineExisting[] = subs.flatMap((s) =>
    s.lines.map((l) => {
      const q = m.lineQty(l);
      return {
        lineId: l.id,
        productKey: productKey(l.productId, l.length),
        orderedKg: l.orderedKg,
        rate: l.rate,
        overpricePerMt: l.overpricePerMt,
        dispatchedKg: q.dispatchedKg,
        reservedKg: q.reservedKg,
        terminal: terminal(s),
      };
    }),
  );
  const desired: EditLineDesired[] = [];
  body.subOrders.forEach((bs, si) => {
    const s = targets[si];
    const intoTerminal = s ? terminal(s) : false;
    bs.lines.forEach((bl, li) => {
      const prev = bl.id !== undefined ? lineById.get(bl.id) : undefined;
      if (prev && prev.s.sub.id !== s?.sub.id) {
        throw new AppError(422, 'VALIDATION', [
          { path: ['subOrders', si, 'lines', li, 'id'], message: 'A line cannot move to another company; use Move quantity' },
        ]);
      }
      const { rate } = lineRate({
        method: body.pricingMethod,
        basicRate: body.basicRate,
        conversionPerMt: prev ? prev.l.conversionSnapshot : (products.get(bl.productId)?.conversionPerMt ?? 0),
        typedRate: bl.typedRate,
      });
      desired.push({
        ...(bl.id !== undefined ? { lineId: bl.id } : {}),
        productKey: productKey(bl.productId, bl.length),
        orderedKg: bl.orderedKg,
        rate,
        overpricePerMt: bl.overpricePerMt,
        terminal: intoTerminal,
      });
    });
  });

  // A line still planned on a truck at the plant cannot disappear from under that truck.
  const keptIds = new Set(desired.flatMap((d) => (d.lineId !== undefined ? [d.lineId] : [])));
  const planned = existing.find((e) => !keptIds.has(e.lineId) && e.reservedKg > 0 && e.dispatchedKg === 0);
  if (planned) throw new AppError(409, 'OPEN_TRUCKS', { lineId: planned.lineId });

  const plan = planOrderEdit({ role: c.user.role, existing, desired });
  const firstError = plan.errors[0];
  if (firstError) {
    throw new AppError(409, firstError.code, firstError.lineId !== undefined ? { lineId: firstError.lineId } : undefined);
  }

  const at = new Date(c.now);
  const removedTrucks = await withLateReferenceCheck(tx, body, async (sp) => {
    let suffixesUsed = g.order.suffixesUsed;
    const keptLines = new Set<string>();
    const keptSubs = new Set<string>();
    const newSubs: { si: number; row: ReturnType<typeof newSubOrderRow> }[] = [];
    body.subOrders.forEach((bs, si) => {
      if (targets[si]) return;
      newSubs.push({ si, row: newSubOrderRow(g.order, bs.companyId, subOrderSuffix(suffixesUsed), at) });
      suffixesUsed += 1;
    });
    await sp
      .update(orders)
      .set({
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
        suffixesUsed,
        version: bumped(orders.version),
        updatedAt: at,
      })
      .where(eq(orders.id, g.order.id));
    if (newSubs.length > 0) await sp.insert(subOrders).values(newSubs.map((n) => n.row));

    const inserts: (typeof orderLines.$inferInsert)[] = [];
    for (const [si, bs] of body.subOrders.entries()) {
      const target = targets[si];
      const sub = target?.sub ?? newSubs.find((n) => n.si === si)?.row;
      if (!sub) throw new Error(`editOrder: no sub-order for body index ${si}`);
      keptSubs.add(sub.id);
      let position = target ? Math.max(-1, ...target.lines.map((l) => l.position)) + 1 : 0;
      for (const bl of bs.lines) {
        const prev = bl.id !== undefined ? lineById.get(bl.id)?.l : undefined;
        if (!prev) {
          inserts.push(newLineRow(body, products, sub, bl, position, at));
          position += 1;
          continue;
        }
        keptLines.add(prev.id);
        await updateLineIfChanged(sp, prev, body, bl, at);
      }
    }
    if (inserts.length > 0) await sp.insert(orderLines).values(inserts);
    // Left out of the body: removable (the plan above refused anything that was not).
    return pruneOrderTree(sp, {
      lineIds: subs.flatMap((s) => s.lines.filter((l) => !keptLines.has(l.id)).map((l) => l.id)),
      subOrderIds: subs.filter((s) => !keptSubs.has(s.sub.id)).map((s) => s.sub.id),
    });
  });

  await logActivity(tx, c.user, c.now, { entityType: 'order', entityId: g.order.id, action: 'order.edited', orderId: g.order.id });
  if (removedTrucks.length > 0) await afterTrucksRemoved(tx, c, { orderId: g.order.id, trucks: removedTrucks });
  return { orderId: g.order.id, warnings: plan.warnings };
}

/** Re-prices a kept line from the body (with its own conversion snapshot); writes only when something changed. */
async function updateLineIfChanged(
  tx: Tx,
  prev: LineRow,
  body: UpdateOrderBody,
  bl: UpdateOrderBody['subOrders'][number]['lines'][number],
  at: Date,
): Promise<void> {
  const { rate, rateEdited } = lineRate({
    method: body.pricingMethod,
    basicRate: body.basicRate,
    conversionPerMt: prev.conversionSnapshot,
    typedRate: bl.typedRate,
  });
  const basicRateSnapshot = body.pricingMethod === 'basic_conversion' ? body.basicRate : null;
  const changed =
    prev.productId !== bl.productId ||
    !sameLength(prev.length, bl.length) ||
    prev.orderedKg !== bl.orderedKg ||
    prev.rate !== rate ||
    prev.rateEdited !== rateEdited ||
    prev.overpricePerMt !== bl.overpricePerMt ||
    prev.basicRateSnapshot !== basicRateSnapshot;
  if (!changed) return;
  await tx
    .update(orderLines)
    .set({
      productId: bl.productId,
      length: { ...bl.length },
      orderedKg: bl.orderedKg,
      rate,
      rateEdited,
      overpricePerMt: bl.overpricePerMt,
      basicRateSnapshot,
      version: bumped(orderLines.version),
      updatedAt: at,
    })
    .where(eq(orderLines.id, prev.id));
}
