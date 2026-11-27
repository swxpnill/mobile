import { type EarningLine, earningFromRates, financialYear, formatLoadingSlip, truckEarning } from '@tonnage/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../../db/client.ts';
import { brokerLedger, companies, orderLines, orders, subOrders, truckAllocations } from '../../db/schema/index.ts';
import { nextNumber } from '../numbering.ts';
import { anyId } from '../orderGraph.ts';

// Ported from packages/mock-api/src/dispatch.ts: the loading slip and the broker ledger at dispatch
// and correction (§5.4; B3 Ruling 5). Every function runs inside the caller's transaction.

/** The truck fields these need. */
export interface TruckRef {
  id: string;
  tenantId: string;
  orderId: string;
  subOrderId: string;
}

/** `LS-<Company>-YYMM-NNNN`, one series per company per financial year (§5.3), at business time. */
export async function issueLoadingSlip(tx: Tx, truck: TruckRef, atMs: number): Promise<string> {
  const [row] = await tx
    .select({ id: companies.id, code: companies.code })
    .from(subOrders)
    .innerJoin(companies, and(eq(companies.tenantId, subOrders.tenantId), eq(companies.id, subOrders.companyId)))
    .where(eq(subOrders.id, truck.subOrderId));
  if (!row) throw new Error(`truck ${truck.id} has no company`);
  const n = await nextNumber(tx, `ls:${row.id}`, financialYear(atMs), atMs);
  return formatLoadingSlip(row.code, atMs, n);
}

const allocationsOf = (tx: Tx, truckId: string) =>
  tx
    .select({ orderLineId: truckAllocations.orderLineId, netKg: truckAllocations.netKg })
    .from(truckAllocations)
    .where(eq(truckAllocations.truckId, truckId))
    .orderBy(asc(truckAllocations.position));

async function orderOf(tx: Tx, truck: TruckRef) {
  const [o] = await tx
    .select({ brokerId: orders.brokerId, commission: orders.commissionPerMtSnapshot })
    .from(orders)
    .where(eq(orders.id, truck.orderId));
  if (!o) throw new Error(`truck ${truck.id} has no order`);
  return o;
}

const linesOf = (tx: Tx, subOrderId: string) =>
  tx
    .select({ id: orderLines.id, overpricePerMt: orderLines.overpricePerMt })
    .from(orderLines)
    .where(eq(orderLines.subOrderId, subOrderId))
    .orderBy(asc(orderLines.position));

async function pushEarning(
  tx: Tx,
  truck: TruckRef,
  brokerId: string,
  { earningRupees, breakdown }: { earningRupees: number; breakdown: EarningLine[] },
  atMs: number,
  actorId: string,
): Promise<void> {
  await tx.insert(brokerLedger).values({
    id: uuidv7(),
    tenantId: truck.tenantId,
    brokerId,
    kind: 'earning',
    truckId: truck.id,
    amountRupees: earningRupees,
    breakdown,
    reversesId: null,
    createdAt: new Date(atMs),
    createdBy: actorId,
  });
}

/**
 * Appends the truck's broker earning (§5.4) from its allocations, at the order's commission
 * snapshot plus each line's overprice. Nothing when the order has no broker.
 */
export async function writeEarning(tx: Tx, truck: TruckRef, atMs: number, actorId: string): Promise<void> {
  const order = await orderOf(tx, truck);
  if (order.brokerId === null) return;
  const lines = new Map((await linesOf(tx, truck.subOrderId)).map((l) => [l.id, l]));
  await pushEarning(tx, truck, order.brokerId, truckEarning(await allocationsOf(tx, truck.id), lines, order.commission ?? 0), atMs, actorId);
}

type LedgerRow = typeof brokerLedger.$inferSelect;

/**
 * Appends the exact negation of the truck's latest earning not yet reversed and returns that
 * earning; nothing (undefined) if there is none.
 */
export async function reverseEarning(tx: Tx, truck: TruckRef, atMs: number, actorId: string): Promise<LedgerRow | undefined> {
  const rows = await tx
    .select()
    .from(brokerLedger)
    .where(eq(brokerLedger.truckId, truck.id))
    .orderBy(desc(brokerLedger.createdAt), desc(brokerLedger.id));
  const reversed = new Set(rows.flatMap((r) => (r.reversesId ? [r.reversesId] : [])));
  const earning = rows.find((r) => r.kind === 'earning' && !reversed.has(r.id));
  if (!earning) return undefined;
  await tx.insert(brokerLedger).values({
    id: uuidv7(),
    tenantId: earning.tenantId,
    brokerId: earning.brokerId,
    kind: 'reversal',
    truckId: truck.id,
    amountRupees: -earning.amountRupees,
    breakdown: earning.breakdown.map((b) => ({ ...b, netKg: -b.netKg })),
    reversesId: earning.id,
    createdAt: new Date(atMs),
    createdBy: actorId,
  });
  return earning;
}

/**
 * A weight correction's earning (§5.2): reverses the current earning, then writes a new one for
 * the truck's new allocations at the reversed earning's per-MT rates (the rates at dispatch).
 * A line the old earning did not cover takes the order's snapshot commission plus its overprice.
 */
export async function rewriteEarning(tx: Tx, truck: TruckRef, atMs: number, actorId: string): Promise<void> {
  const old = await reverseEarning(tx, truck, atMs, actorId);
  if (!old) {
    await writeEarning(tx, truck, atMs, actorId);
    return;
  }
  const order = await orderOf(tx, truck);
  const atDispatch = new Map(old.breakdown.map((b) => [b.orderLineId, { commissionPerMt: b.commissionPerMt, overpricePerMt: b.overpricePerMt }]));
  const commission = order.commission ?? 0;
  const rates = new Map(
    (await linesOf(tx, truck.subOrderId)).map((l) => [l.id, atDispatch.get(l.id) ?? { commissionPerMt: commission, overpricePerMt: l.overpricePerMt }]),
  );
  await pushEarning(tx, truck, old.brokerId, earningFromRates(await allocationsOf(tx, truck.id), rates), atMs, actorId);
}

/** Removes the trucks' earning and reversal rows (an order's hard delete; payments stay). */
export async function removeTruckLedger(tx: Tx, truckIds: readonly string[]): Promise<void> {
  if (truckIds.length === 0) return;
  // Reversals first: they point at the earnings they reverse.
  await tx.delete(brokerLedger).where(and(anyId(brokerLedger.truckId, truckIds), eq(brokerLedger.kind, 'reversal')));
  await tx.delete(brokerLedger).where(and(anyId(brokerLedger.truckId, truckIds), eq(brokerLedger.kind, 'earning')));
}
