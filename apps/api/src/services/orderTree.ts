import { linesHeldByTrucks } from '@tonnage/shared';
import { and, asc, eq, sql, type SQLWrapper } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { companies, orderLines, orders, subOrders, truckAllocations, truckPlanLines, trucks } from '../db/schema/index.ts';
import { removeTruckLedger } from './dispatch/money.ts';
import type { OrderGraph, SubOrderGraph } from '../views/orderGraph.ts';
import { anyId, loadOrderGraph } from './orderGraph.ts';

/**
 * Row locks for order writes, always taken in the API's one lock order (see the comment at the top
 * of `orderLifecycle.ts`): companies → the order row → its sub-orders by id → their lines by id →
 * their trucks by id. Every write that touches an order's tree takes the order row first, so two
 * such writes on one order queue on that row and never interleave further down.
 */
export type OrderLockMode = 'no key update' | 'update';

/** The order row, locked; false when it is not there (or not this tenant's, through RLS). */
async function lockOrderRow(tx: Tx, orderId: string, mode: OrderLockMode): Promise<boolean> {
  const rows = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for(mode);
  return rows.length > 0;
}

/**
 * Locks the order row, then its sub-orders (all, or only `subOrderId`), their lines and, with
 * `trucks`, their trucks, each set in id order; then loads the graph as it now stands (the writes
 * that committed while this waited are in it). Undefined when the order is gone.
 */
export async function lockOrderTree(
  tx: Tx,
  orderId: string,
  opts: { mode: OrderLockMode; subOrderId?: string; trucks?: boolean },
): Promise<OrderGraph | undefined> {
  if (!(await lockOrderRow(tx, orderId, opts.mode))) return undefined;
  const subRows = await tx
    .select({ id: subOrders.id })
    .from(subOrders)
    .where(and(eq(subOrders.orderId, orderId), opts.subOrderId === undefined ? undefined : eq(subOrders.id, opts.subOrderId)))
    .orderBy(asc(subOrders.id))
    .for(opts.mode);
  const subIds = subRows.map((s) => s.id);
  if (subIds.length > 0) {
    await tx
      .select({ id: orderLines.id })
      .from(orderLines)
      .where(anyId(orderLines.subOrderId, subIds))
      .orderBy(asc(orderLines.id))
      .for(opts.mode);
    if (opts.trucks === true) {
      await tx.select({ id: trucks.id }).from(trucks).where(anyId(trucks.subOrderId, subIds)).orderBy(asc(trucks.id)).for(opts.mode);
    }
  }
  return (await loadOrderGraph(tx, [orderId])).get(orderId);
}

/**
 * A company, FOR SHARE (first in the lock order, as `validateOrderRefs` takes them): a concurrent
 * deactivation either committed before, and this reads `active = false`, or waits for this write.
 * Undefined for an unknown company.
 */
export async function shareCompany(tx: Tx, companyId: string): Promise<{ id: string; active: boolean } | undefined> {
  const [row] = await tx
    .select({ id: companies.id, active: companies.active })
    .from(companies)
    .where(eq(companies.id, companyId))
    .for('share');
  return row;
}

/** Lines of these sub-orders a truck still plans or carries (shared `linesHeldByTrucks`): an edit or move may not remove them. */
export const heldLines = (subs: readonly SubOrderGraph[]): Set<string> =>
  linesHeldByTrucks(subs.flatMap((s) => s.trucks.map((t) => ({ state: t.truck.state, plan: t.plan, allocations: t.allocations }))));

/** `version + 1` for an update's `set`. */
export const bumped = (column: SQLWrapper) => sql<number>`${column} + 1`;

/** A truck removed with its sub-order: B3 writes its tombstone (`afterTrucksRemoved`). */
export interface RemovedTruck {
  id: string;
  plantId: string;
}

/**
 * Removes order lines and sub-orders (both already locked by `lockOrderTree`) in foreign-key-safe
 * order: the plan and allocation rows on those lines, the trucks on those sub-orders with their
 * plan and allocation rows, the lines, the sub-orders. The callers' guards leave only rows that
 * carry nothing (cancelled trucks, zero plans) on what they remove; the mock simply forgets them.
 * Returns the trucks removed, oldest first.
 */
export async function pruneOrderTree(
  tx: Tx,
  remove: { lineIds: readonly string[]; subOrderIds: readonly string[] },
): Promise<RemovedTruck[]> {
  const { lineIds, subOrderIds } = remove;
  const removedTrucks =
    subOrderIds.length === 0
      ? []
      : await tx
          .select({ id: trucks.id, plantId: trucks.plantId })
          .from(trucks)
          .where(anyId(trucks.subOrderId, subOrderIds))
          .orderBy(asc(trucks.id));
  const truckIds = removedTrucks.map((t) => t.id);
  // B3: the trucks' broker earnings and reversals go with them (payments stay, as in the mock).
  await removeTruckLedger(tx, truckIds);
  if (lineIds.length > 0) {
    await tx.delete(truckAllocations).where(anyId(truckAllocations.orderLineId, lineIds));
    await tx.delete(truckPlanLines).where(anyId(truckPlanLines.orderLineId, lineIds));
  }
  if (truckIds.length > 0) {
    await tx.delete(truckAllocations).where(anyId(truckAllocations.truckId, truckIds));
    await tx.delete(truckPlanLines).where(anyId(truckPlanLines.truckId, truckIds));
    await tx.delete(trucks).where(anyId(trucks.id, truckIds));
  }
  if (lineIds.length > 0) await tx.delete(orderLines).where(anyId(orderLines.id, lineIds));
  if (subOrderIds.length > 0) await tx.delete(subOrders).where(anyId(subOrders.id, subOrderIds));
  return removedTrucks;
}
