import type { Tx } from '../db/client.ts';
import type { AuthedUser } from '../http/auth-hook.ts';

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
 * After a sub-order is short closed (Task 6 calls it). B3 (sync): a sync push to the plant's phones
 * for the trucks it cancelled. B4 (notifications): the short-close notification.
 */
export async function afterShortClose(
  tx: Tx,
  ctx: OrderEffectCtx,
  e: { orderId: string; subOrderId: string; cancelledTruckIds: readonly string[] },
): Promise<void> {
  void tx;
  void ctx;
  void e;
}

/**
 * After an order is hard deleted (Task 6 calls it). B3 (sync): truck tombstones with
 * `reason: 'deleted'` so phones drop the tasks. B4 (ledger, notifications): remove the trucks'
 * earning and reversal rows, and the order's notifications.
 */
export async function afterOrderDeleted(
  tx: Tx,
  ctx: OrderEffectCtx,
  e: { orderId: string; trucks: readonly { id: string; plantId: string }[] },
): Promise<void> {
  void tx;
  void ctx;
  void e;
}

/**
 * After an edit or a move quantity removed a sub-order together with the trucks on it (only trucks
 * that carry nothing: cancelled, or planned at 0). B3 (sync): truck tombstones so phones drop them.
 */
export async function afterTrucksRemoved(
  tx: Tx,
  ctx: OrderEffectCtx,
  e: { orderId: string; trucks: readonly { id: string; plantId: string }[] },
): Promise<void> {
  void tx;
  void ctx;
  void e;
}
