/**
 * The order lifecycle after booking, as the mock's `handlers/order-lifecycle.ts`: short close,
 * reopen, move quantity, delete preview, hard delete, activity (the edit is in `orderEdit.ts`).
 *
 * LOCK ORDER (binding for every write in the API that touches orders; it avoids deadlocks):
 *   1. companies, FOR SHARE, sorted by id (`validateOrderRefs`, `shareCompany`): order create,
 *      edit, move, reopen. Company deactivation takes its company FOR UPDATE, then counts sub-orders.
 *   2. the order row: FOR NO KEY UPDATE (edit, move, short close, reopen), FOR UPDATE (hard delete).
 *   3. its sub-orders, by id (all of them, or the one being closed or reopened).
 *   4. their order lines, by id.
 *   5. their trucks, by id (edit and move may remove cancelled ones; short close cancels open ones;
 *      hard delete removes all).
 * Every write takes the order row before anything below it, so two writes on one order queue on
 * that row. B3's truck writes (assign, weighments, approval) must follow the same order: lock the
 * order row (or at least the sub-order) before the truck, never a truck and then its order.
 *
 * Version checks: a write first reads without locks for the mock's error order (404, then 409
 * STALE, then reference checks), then checks the version again under the order lock, so a write
 * that committed while this one waited makes it 409 STALE. Every response is built after the
 * write, from the graph as it now stands.
 */
import {
  type ActivityEntry,
  type DeletePreview,
  type MoveQuantityBody,
  type ShortCloseBody,
  assignable,
  isTerminal,
  subOrderSuffix,
} from '@tonnage/shared';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../db/client.ts';
import { activityLog, orderLines, orders, subOrders, trucks, users } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { type LineRow, type OrderGraph, type SubOrderGraph, graphMath, truckNetKg } from '../views/orderGraph.ts';
import { logActivity } from './activity.ts';
import { afterOrderDeleted, afterShortClose, afterTrucksRemoved } from './orderEffects.ts';
import type { OrderWriteCtx } from './orderEdit.ts';
import { productKey } from './orderEdit.ts';
import { anyId, findOrder } from './orderGraph.ts';
import { bumped, heldLines, lockOrderTree, pruneOrderTree, shareCompany } from './orderTree.ts';
import { newSubOrderRow } from './orders.ts';
import { isId, visibleCompanies } from './org.ts';
import { loadProducts } from './products.ts';
import { loadSettings } from './settings.ts';

const SHORT_CLOSE_TRUCK_REASON = 'Order short closed';

/** The sub-order's order and company, when the sub-order exists and the caller sees its company; 404 otherwise. */
async function visibleSubOrder(
  tx: Tx,
  c: OrderWriteCtx,
  subOrderId: string | undefined,
): Promise<{ orderId: string; companyId: string }> {
  if (!isId(subOrderId)) throw new AppError(404, 'NOT_FOUND');
  const [row] = await tx
    .select({ orderId: subOrders.orderId, companyId: subOrders.companyId })
    .from(subOrders)
    .where(eq(subOrders.id, subOrderId));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  const visible = await visibleCompanies(tx, c.scope);
  if (!visible.some((x) => x.id === row.companyId)) throw new AppError(404, 'NOT_FOUND');
  return row;
}

/**
 * Locks the order and the one sub-order (with its lines and trucks); 404 when either is gone.
 * With `shareCompany`, the sub-order's company is taken FOR SHARE first (the lock order) and returned.
 */
async function lockSubOrder(
  tx: Tx,
  c: OrderWriteCtx,
  subOrderId: string | undefined,
  opts: { shareCompany?: boolean } = {},
): Promise<{ g: OrderGraph; s: SubOrderGraph; company: { id: string; active: boolean } | undefined }> {
  const head = await visibleSubOrder(tx, c, subOrderId);
  const company = opts.shareCompany === true ? await shareCompany(tx, head.companyId) : undefined;
  const g = await lockOrderTree(tx, head.orderId, { mode: 'no key update', subOrderId, trucks: true });
  const s = g?.subOrders.find((x) => x.sub.id === subOrderId);
  if (!g || !s) throw new AppError(404, 'NOT_FOUND');
  return { g, s, company };
}

const bumpOrder = (tx: Tx, orderId: string, at: Date) =>
  tx.update(orders).set({ version: bumped(orders.version), updatedAt: at }).where(eq(orders.id, orderId));

const setClosedKg = (tx: Tx, line: LineRow, closedKg: number, at: Date) =>
  tx
    .update(orderLines)
    .set({ closedKg, version: bumped(orderLines.version), updatedAt: at })
    .where(eq(orderLines.id, line.id));

/**
 * `POST /v1/sub-orders/:id/short-close`: closes what is pending on every line. With open trucks it
 * refuses (409 OPEN_TRUCKS listing them) unless `cancelOpenTrucks`, which cancels them. Nothing
 * dispatched makes it a cancel. Returns the order id.
 */
export async function shortCloseSubOrder(
  tx: Tx,
  c: OrderWriteCtx,
  subOrderId: string | undefined,
  body: ShortCloseBody,
): Promise<string> {
  const { g, s } = await lockSubOrder(tx, c, subOrderId);
  const m = graphMath(g);
  if (body.version !== s.sub.version) throw new AppError(409, 'STALE');
  // Completed (nothing pending) is closed too: short closing it would rewrite history.
  if (s.sub.closeKind !== null || isTerminal(m.subOrderStatus(s))) throw new AppError(409, 'ALREADY_CLOSED');
  const open = m.openTrucksOf(s);
  if (open.length > 0 && !body.cancelOpenTrucks) throw new AppError(409, 'OPEN_TRUCKS', { trucks: open });

  const at = new Date(c.now);
  const cancelledTruckIds = open.map((t) => t.id);
  if (cancelledTruckIds.length > 0) {
    await tx
      .update(trucks)
      .set({
        state: 'cancelled',
        cancelledAt: at,
        cancelledBy: c.user.id,
        cancelReason: SHORT_CLOSE_TRUCK_REASON,
        version: bumped(trucks.version),
        updatedAt: at,
      })
      .where(anyId(trucks.id, cancelledTruckIds));
  }
  // Pending after the cancellations: reserved no longer matters, dispatched is unchanged.
  let dispatched = 0;
  for (const l of s.lines) {
    const q = m.lineQty(l);
    dispatched += q.dispatchedKg;
    const closed = Math.max(0, q.orderedKg - q.dispatchedKg);
    if (closed !== l.closedKg) await setClosedKg(tx, l, closed, at);
  }
  await tx
    .update(subOrders)
    .set({
      closeKind: dispatched === 0 ? 'cancel' : 'short_close',
      closeReason: body.reason,
      closeNote: body.note === '' ? null : body.note,
      closedAt: at,
      closedBy: c.user.id,
      version: bumped(subOrders.version),
      updatedAt: at,
    })
    .where(eq(subOrders.id, s.sub.id));
  await bumpOrder(tx, g.order.id, at);
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: g.order.id,
    action: dispatched === 0 ? 'order.sub_cancelled' : 'order.short_closed',
    meta: { subOrderId: s.sub.id, suffix: s.sub.suffix, reason: body.reason, trucksCancelled: cancelledTruckIds.length },
    orderId: g.order.id,
  });
  await afterShortClose(tx, c, { orderId: g.order.id, subOrderId: s.sub.id, cancelledTruckIds });
  return g.order.id;
}

/**
 * `POST /v1/sub-orders/:id/reopen` (owner): pending comes back on every line. Ruling R10: not on a
 * company deactivated since the close (409 COMPANY_INACTIVE). The company is held FOR SHARE first,
 * so a deactivation either committed before (and this refuses) or waits and counts the reopened
 * sub-order (409 COMPANY_HAS_OPEN_ORDERS). Returns the order id.
 */
export async function reopenSubOrder(
  tx: Tx,
  c: OrderWriteCtx,
  subOrderId: string | undefined,
  version: number,
): Promise<string> {
  const { g, s, company } = await lockSubOrder(tx, c, subOrderId, { shareCompany: true });
  if (version !== s.sub.version) throw new AppError(409, 'STALE');
  if (s.sub.closeKind === null) throw new AppError(409, 'NOT_CLOSED');
  if (!company?.active) throw new AppError(409, 'COMPANY_INACTIVE');
  const at = new Date(c.now);
  for (const l of s.lines) {
    if (l.closedKg !== 0) await setClosedKg(tx, l, 0, at);
  }
  await tx
    .update(subOrders)
    .set({
      closeKind: null,
      closeReason: null,
      closeNote: null,
      closedAt: null,
      closedBy: null,
      version: bumped(subOrders.version),
      updatedAt: at,
    })
    .where(eq(subOrders.id, s.sub.id));
  await bumpOrder(tx, g.order.id, at);
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: g.order.id,
    action: 'order.reopened',
    meta: { subOrderId: s.sub.id, suffix: s.sub.suffix },
    orderId: g.order.id,
  });
  return g.order.id;
}

/**
 * `POST /v1/orders/:id/move-quantity`: moves undispatched, unreserved kg of one line to another
 * company, into its line of the same product, length and price, or a new one; a company without a
 * sub-order gets one with the next unused suffix. A source line left at 0 (nothing dispatched)
 * goes, and its sub-order with it when it was the last. Returns the order id.
 */
export async function moveQuantity(
  tx: Tx,
  c: OrderWriteCtx,
  orderId: string | undefined,
  body: MoveQuantityBody,
): Promise<string> {
  const { graph: seen } = await findOrder(tx, c.user, c.scope, c.now, orderId);
  if (body.version !== seen.order.version) throw new AppError(409, 'STALE');
  const company = await shareCompany(tx, body.toCompanyId);
  const g = await lockOrderTree(tx, seen.order.id, { mode: 'no key update', trucks: true });
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.order.version !== body.version) throw new AppError(409, 'STALE');

  const m = graphMath(g);
  const terminal = (s: SubOrderGraph) => isTerminal(m.subOrderStatus(s));
  const fromSub = g.subOrders.find((s) => s.lines.some((l) => l.id === body.fromLineId));
  const from = fromSub?.lines.find((l) => l.id === body.fromLineId);
  if (!fromSub || !from) {
    throw new AppError(422, 'VALIDATION', [{ path: ['fromLineId'], message: 'This line is not on the order' }]);
  }
  if (terminal(fromSub)) throw new AppError(409, 'ORDER_LOCKED', { subOrderId: fromSub.sub.id });
  if (body.toCompanyId === fromSub.sub.companyId) {
    throw new AppError(422, 'VALIDATION', [{ path: ['toCompanyId'], message: 'Choose another company' }]);
  }
  if (!company) throw new AppError(422, 'VALIDATION', [{ path: ['toCompanyId'], message: 'Unknown company' }]);
  if (!company.active) throw new AppError(409, 'COMPANY_INACTIVE');
  const product = (await loadProducts(tx, [from.productId])).get(from.productId);
  if (!product?.companyIds.includes(company.id)) throw new AppError(409, 'PRODUCT_NOT_FOR_COMPANY');
  const fromQty = m.lineQty(from);
  const availableKg = Math.max(0, assignable(fromQty));
  if (body.kg > availableKg) throw new AppError(409, 'MOVE_EXCEEDS_AVAILABLE', { availableKg });
  // Moving all of a line removes it; one a truck still plans or carries (not cancelled) must stay.
  const removeFrom = from.orderedKg === body.kg && fromQty.dispatchedKg === 0;
  if (removeFrom && heldLines([fromSub]).has(from.id)) throw new AppError(409, 'OPEN_TRUCKS', { lineId: from.id });
  const toSub = g.subOrders.find((s) => s.sub.companyId === company.id);
  if (toSub && terminal(toSub)) throw new AppError(409, 'ORDER_LOCKED', { subOrderId: toSub.sub.id });

  const at = new Date(c.now);
  let suffixesUsed = g.order.suffixesUsed;
  let to: { id: string; suffix: string };
  if (toSub) {
    to = toSub.sub;
  } else {
    const row = newSubOrderRow(g.order, company.id, subOrderSuffix(suffixesUsed), at);
    suffixesUsed += 1;
    await tx.insert(subOrders).values(row);
    to = row;
  }
  const same = (l: LineRow) =>
    productKey(l.productId, l.length) === productKey(from.productId, from.length) &&
    l.rate === from.rate &&
    l.overpricePerMt === from.overpricePerMt;
  const target = toSub?.lines.find(same);
  if (target) {
    await tx
      .update(orderLines)
      .set({ orderedKg: sql`${orderLines.orderedKg} + ${body.kg}`, version: bumped(orderLines.version), updatedAt: at })
      .where(eq(orderLines.id, target.id));
  } else {
    await tx.insert(orderLines).values({
      id: uuidv7(),
      tenantId: from.tenantId,
      subOrderId: to.id,
      position: toSub ? Math.max(-1, ...toSub.lines.map((l) => l.position)) + 1 : 0,
      productId: from.productId,
      length: { ...from.length },
      orderedKg: body.kg,
      basicRateSnapshot: from.basicRateSnapshot,
      conversionSnapshot: from.conversionSnapshot,
      rate: from.rate,
      rateEdited: from.rateEdited,
      overpricePerMt: from.overpricePerMt,
      closedKg: 0,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }
  const left = from.orderedKg - body.kg;
  if (!removeFrom) {
    await tx
      .update(orderLines)
      .set({ orderedKg: left, version: bumped(orderLines.version), updatedAt: at })
      .where(eq(orderLines.id, from.id));
  }
  // Ruling R9: the source and an existing target sub-order change lines, so screens showing them are
  // now stale (a short close with the older version is 409 STALE). A new target starts at version 1.
  await tx
    .update(subOrders)
    .set({ version: bumped(subOrders.version), updatedAt: at })
    .where(anyId(subOrders.id, toSub ? [fromSub.sub.id, toSub.sub.id] : [fromSub.sub.id]));
  const removedTrucks = await pruneOrderTree(tx, {
    lineIds: removeFrom ? [from.id] : [],
    subOrderIds: removeFrom && fromSub.lines.length === 1 ? [fromSub.sub.id] : [],
  });
  await tx
    .update(orders)
    .set({ suffixesUsed, version: bumped(orders.version), updatedAt: at })
    .where(eq(orders.id, g.order.id));
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: g.order.id,
    action: 'order.quantity_moved',
    meta: {
      fromLineId: from.id,
      fromSubOrderId: fromSub.sub.id,
      toSubOrderId: to.id,
      fromSuffix: fromSub.sub.suffix,
      toSuffix: to.suffix,
      kg: body.kg,
    },
    orderId: g.order.id,
  });
  if (removedTrucks.length > 0) await afterTrucksRemoved(tx, c, { orderId: g.order.id, trucks: removedTrucks });
  return g.order.id;
}

/** What a hard delete would remove (the mock's counts: weighments derived from each truck's tare and state). */
export function deletePreview(g: OrderGraph): DeletePreview {
  const all = g.subOrders.flatMap((s) => s.trucks);
  return {
    subOrders: g.subOrders.length,
    lines: g.subOrders.reduce((n, s) => n + s.lines.length, 0),
    trucks: all.length,
    dispatchedKg: all.filter((t) => t.truck.state === 'dispatched').reduce((n, t) => n + truckNetKg(t), 0),
    weighments: all.reduce((n, t) => n + (t.truck.tareKg !== null ? 1 : 0) + (t.truck.state === 'dispatched' ? 1 : 0), 0),
  };
}

/**
 * `DELETE /v1/orders/:id` (owner): after the typed confirmation, removes the order and everything
 * under it in foreign-key-safe order (allocations, plans, trucks, lines, sub-orders, the order's
 * activity, the order), all under the order lock, then calls `afterOrderDeleted`.
 */
export async function hardDeleteOrder(
  tx: Tx,
  c: OrderWriteCtx,
  orderId: string | undefined,
  body: { confirmNumber: string },
): Promise<void> {
  const { graph: seen } = await findOrder(tx, c.user, c.scope, c.now, orderId);
  const g = await lockOrderTree(tx, seen.order.id, { mode: 'update', trucks: true });
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (body.confirmNumber.trim().toUpperCase() !== g.order.number.toUpperCase()) {
    throw new AppError(409, 'CONFIRMATION_MISMATCH');
  }
  const settings = await loadSettings(tx, c.user.tenantId);
  if (deletePreview(g).dispatchedKg > 0 && !settings.allowHardDeleteAfterDispatch) {
    throw new AppError(409, 'HARD_DELETE_DISABLED');
  }
  const id = g.order.id;
  const removedTrucks = await pruneOrderTree(tx, {
    lineIds: g.subOrders.flatMap((s) => s.lines.map((l) => l.id)),
    subOrderIds: g.subOrders.map((s) => s.sub.id),
  });
  await tx
    .delete(activityLog)
    .where(or(eq(activityLog.orderId, id), and(eq(activityLog.entityType, 'order'), eq(activityLog.entityId, id))));
  await tx.delete(orders).where(eq(orders.id, id));
  await afterOrderDeleted(tx, c, { orderId: id, trucks: removedTrucks });
}

/**
 * `GET /v1/orders/:id/activity`: the order's history, newest first. A plant head sees only their
 * companies' sub-orders, so entries about the others are left out too.
 */
export async function orderActivity(tx: Tx, c: OrderWriteCtx, orderId: string | undefined): Promise<ActivityEntry[]> {
  const { graph, ctx } = await findOrder(tx, c.user, c.scope, c.now, orderId);
  const hidden = new Set(graph.subOrders.filter((s) => !ctx.visibleCompanyIds.has(s.sub.companyId)).map((s) => s.sub.id));
  const mentionsHidden = (meta: Record<string, unknown>) =>
    ['subOrderId', 'fromSubOrderId', 'toSubOrderId'].some((k) => {
      const v = meta[k];
      return typeof v === 'string' && hidden.has(v);
    });
  const rows = await tx
    .select({ id: activityLog.id, action: activityLog.action, at: activityLog.at, meta: activityLog.meta, actorName: users.name })
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .where(and(eq(activityLog.entityType, 'order'), eq(activityLog.entityId, graph.order.id)))
    .orderBy(desc(activityLog.at), desc(activityLog.id));
  return rows
    .filter((r) => !mentionsHidden(r.meta))
    .map((r) => ({
      id: r.id,
      action: r.action,
      actorName: r.actorName ?? '',
      at: r.at.toISOString(),
      // The mock keeps no meta when an entry has none; an empty object is stored for those here.
      ...(Object.keys(r.meta).length > 0 ? { meta: { ...r.meta } } : {}),
    }));
}
