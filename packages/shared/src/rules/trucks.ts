import type { TruckState } from '../schemas/orders.ts';
import { roundHalfUp } from './money.ts';
import { over, pending, type LineQty } from './quantities.ts';

export type TruckEvent = 'at_gate' | 'tare' | 'gross' | 'cancel';

/** Gate-clock skew beyond this (ms) is flagged on a weighment. */
export const CLOCK_SKEW_FLAG_MS = 300_000;

export const TRUCK_CANCEL_REASONS = ['Vehicle did not arrive', 'Order short closed', 'Wrong vehicle', 'Other'] as const;

/** The truck lifecycle; `null` means the event is not allowed in that state. */
export function nextTruckState(state: TruckState, event: TruckEvent): TruckState | null {
  if (state === 'dispatched' || state === 'cancelled') return null;
  switch (event) {
    case 'at_gate':
      return state === 'assigned' ? 'at_gate' : null;
    case 'tare':
      return 'loading'; // assigned | at_gate | loading (a correction)
    case 'gross':
      return state === 'loading' ? 'dispatched' : null;
    case 'cancel':
      return 'cancelled';
  }
}

export function netKg(grossKg: number, tareKg: number): number {
  return grossKg - tareKg;
}

/** Largest-remainder split of net kg over planned kg, in integers; sums exactly to `netKg`. */
export function splitProRata(
  netKg: number,
  plan: { orderLineId: string; plannedKg: number }[],
): { orderLineId: string; netKg: number }[] {
  if (plan.length === 0) throw new Error('cannot split over an empty plan');
  const planTotal = plan.reduce((s, p) => s + p.plannedKg, 0);
  // An all-zero plan splits evenly: every line weighs 1.
  const weights = planTotal === 0 ? plan.map(() => 1) : plan.map((p) => p.plannedKg);
  const total = planTotal === 0 ? plan.length : planTotal;
  const shares = weights.map((w, i) => {
    const num = netKg * w;
    return { i, base: Math.floor(num / total), rem: num % total };
  });
  let left = netKg - shares.reduce((s, x) => s + x.base, 0);
  const byRemainder = [...shares].sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const s of byRemainder) {
    if (left <= 0) break;
    s.base += 1;
    left -= 1;
  }
  return plan.map((p, i) => ({ orderLineId: p.orderLineId, netKg: shares[i]!.base }));
}

export function checkAllocations(
  netKg: number,
  allocations: { orderLineId: string; netKg: number }[],
  lineIds: ReadonlySet<string>,
): 'ok' | 'ALLOC_MISMATCH' | 'LINE_REMOVED' | 'INVALID_WEIGHT' {
  if (netKg <= 0 || allocations.some((a) => a.netKg < 0)) return 'INVALID_WEIGHT';
  if (allocations.some((a) => !lineIds.has(a.orderLineId))) return 'LINE_REMOVED';
  if (allocations.reduce((s, a) => s + a.netKg, 0) !== netKg) return 'ALLOC_MISMATCH';
  return 'ok';
}

/** Net far from the plan: under half is `low`, over one and a half times is `high`. */
export function plausibility(netKg: number, plannedKg: number): 'ok' | 'low' | 'high' {
  if (plannedKg === 0) return 'ok';
  if (netKg * 2 < plannedKg) return 'low';
  if (netKg * 2 > plannedKg * 3) return 'high';
  return 'ok';
}

/**
 * Per-line `closedKg` to set when the sub-order is within tolerance, nothing else is on the
 * road and something was dispatched; otherwise `null`.
 */
export function toleranceCloseKg(lines: LineQty[], toleranceKg: number, otherOpenTrucks: number): number[] | null {
  if (otherOpenTrucks !== 0) return null;
  if (!lines.some((l) => l.dispatchedKg > 0)) return null;
  const pend = lines.map(pending);
  if (pend.reduce((s, p) => s + p, 0) > toleranceKg) return null;
  return pend;
}

export function overToleranceKg(lines: LineQty[], toleranceKg: number): number {
  const total = lines.reduce((s, l) => s + over(l), 0);
  return total > toleranceKg ? total : 0;
}

export function truckEarning(
  allocations: { orderLineId: string; netKg: number }[],
  lines: ReadonlyMap<string, { overpricePerMt: number }>,
  commissionPerMt: number,
): { earningRupees: number; breakdown: { orderLineId: string; netKg: number; perMt: number }[] } {
  const breakdown = allocations.map((a) => {
    const line = lines.get(a.orderLineId);
    if (!line) throw new Error(`no order line ${a.orderLineId} for earning`);
    return { orderLineId: a.orderLineId, netKg: a.netKg, perMt: commissionPerMt + line.overpricePerMt };
  });
  const earningRupees = roundHalfUp(
    breakdown.reduce((s, b) => s + b.netKg * b.perMt, 0),
    1000,
  );
  return { earningRupees, breakdown };
}
