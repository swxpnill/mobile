import type { Tx } from '../db/client.ts';
import { syncEvents, truckTombstones, trucks } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { bumpChangeClock } from './changeClock.ts';
import { anyId } from './orderGraph.ts';

/**
 * Side effects of order writes that belong to later milestones (Ruling 3). Each hook runs inside
 * the request's transaction, after the write, so what it adds commits or rolls back with it. They
 * do nothing in B2; the M2 contract suites do not assert their effects.
 */
export interface OrderEffectCtx {
  user: AuthedUser;
  now: number;
}

/**
 * After an order is booked. B4 (notifications): the mock's `notifyOrderCreated` (rows and push
 * outbox for the people who are told).
 */
export async function afterOrderCreated(tx: Tx, ctx: OrderEffectCtx, orderId: string): Promise<void> {
  void tx;
  void ctx;
  void orderId;
}

/**
 * After a sub-order is short closed (Task 6 calls it). B3 (sync): the trucks it cancelled take the
 * change-clock time, so the plant's next pull lists them in `removed` (B3 Ruling 3). B4: the sync
 * push to the plant's phones and the short-close notification.
 */
export async function afterShortClose(
  tx: Tx,
  ctx: OrderEffectCtx,
  e: { orderId: string; subOrderId: string; cancelledTruckIds: readonly string[] },
): Promise<void> {
  if (e.cancelledTruckIds.length === 0) return;
  const at = new Date(await bumpChangeClock(tx, ctx.user.tenantId, ctx.now));
  await tx.update(trucks).set({ updatedAt: at }).where(anyId(trucks.id, e.cancelledTruckIds));
}

/**
 * After an order is hard deleted (Task 6 calls it; the trucks' ledger earnings and reversals went
 * with the trucks, B3 Ruling 5). B3 (sync): truck tombstones with `reason: 'deleted'` at the
 * change-clock time, so phones drop the tasks and settle their outbox rows, and the trucks' sync
 * event claims. B4: the order's notifications.
 */
export async function afterOrderDeleted(
  tx: Tx,
  ctx: OrderEffectCtx,
  e: { orderId: string; trucks: readonly { id: string; plantId: string }[] },
): Promise<void> {
  if (e.trucks.length === 0) return;
  const removedAt = new Date(await bumpChangeClock(tx, ctx.user.tenantId, ctx.now));
  await tx
    .insert(truckTombstones)
    .values(e.trucks.map((t) => ({ tenantId: ctx.user.tenantId, truckId: t.id, plantId: t.plantId, reason: 'deleted' as const, removedAt })))
    .onConflictDoNothing();
  await forgetSyncEvents(tx, e.trucks);
}

/** The trucks' sync event claims (no foreign key: the rows outlive nothing they point at). */
async function forgetSyncEvents(tx: Tx, gone: readonly { id: string }[]): Promise<void> {
  await tx.delete(syncEvents).where(
    anyId(
      syncEvents.truckId,
      gone.map((t) => t.id),
    ),
  );
}

/**
 * After an edit or a move quantity removed a sub-order together with the trucks on it (only trucks
 * that carry nothing: cancelled, or planned at 0). Phones already had them in `removed` when they
 * were cancelled, as on the mock, so no tombstone; their sync event claims go with them.
 */
export async function afterTrucksRemoved(
  tx: Tx,
  ctx: OrderEffectCtx,
  e: { orderId: string; trucks: readonly { id: string; plantId: string }[] },
): Promise<void> {
  void ctx;
  if (e.trucks.length > 0) await forgetSyncEvents(tx, e.trucks);
}
