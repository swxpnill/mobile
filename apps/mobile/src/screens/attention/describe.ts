import { type ErrorCode, type Rejection, type Truck, type UnitBasis, toDisplayQty } from '@tonnage/shared';
import { MSG, weightCodeMessage } from '../messages';

export const EVENT_LABEL: Record<Rejection['eventType'], string> = {
  AT_GATE: 'Arrived',
  TARE: 'Tare',
  GROSS: 'Gross',
};

/** Why a weight was refused, always in plain words: an unknown code reads as the generic message. */
export function rejectionReason(code: ErrorCode): string {
  return weightCodeMessage(code) ?? MSG.generic;
}

const kgOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** What the phone sent, in the user's basis: "Tare 12.460 MT", "Gross 22.460 MT · net 10.000 MT". */
export function sentLine(r: Rejection, basis: UnitBasis): string {
  const q = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  if (r.eventType === 'AT_GATE') return 'Marked arrived';
  if (r.eventType === 'TARE') {
    const tare = kgOf(r.payload.tareKg);
    return tare === null ? 'Tare' : `Tare ${q(tare)}`;
  }
  const gross = kgOf(r.payload.grossKg);
  const allocations = Array.isArray(r.payload.allocations) ? r.payload.allocations : [];
  const net = allocations.reduce<number>((s, a) => s + (kgOf((a as { netKg?: unknown }).netKg) ?? 0), 0);
  if (gross === null) return 'Gross';
  return allocations.length > 0 ? `Gross ${q(gross)} · net ${q(net)}` : `Gross ${q(gross)}`;
}

/**
 * The weights a restore re-runs with this one: it and every later open rejection of the same
 * truck (the server also matches the phone and runs them in the phone's order). The list is
 * newest first, so "later" is the same time or newer, listed before it.
 */
export function chainOf(r: Rejection, list: readonly Rejection[]): Rejection[] {
  const at = list.findIndex((x) => x.id === r.id);
  const later = list
    .slice(0, Math.max(0, at))
    .filter((x) => x.truckId === r.truckId && x.status === 'open' && x.createdAt >= r.createdAt);
  return [r, ...later.reverse()];
}

/** An older weight of the same truck is still open: it should usually be restored first. */
export function hasEarlierOpen(r: Rejection, list: readonly Rejection[]): boolean {
  const at = list.findIndex((x) => x.id === r.id);
  return at >= 0 && list.slice(at + 1).some((x) => x.truckId === r.truckId && x.status === 'open' && x.id !== r.id);
}

/** What Restore will do, in plain words, from the truck as it is now and the weights going back. */
export function restoreExplanation(
  r: Rejection,
  chain: readonly Rejection[],
  truck: Pick<Truck, 'state' | 'tareKg'> | undefined,
): string {
  const v = r.vehicleNo;
  const gross = chain.some((x) => x.eventType === 'GROSS');
  const tare = chain.some((x) => x.eventType === 'TARE');
  const cancelled = (truck?.state ?? r.serverState) === 'cancelled';
  if (cancelled) {
    const back = tare || gross || (truck?.tareKg ?? null) !== null ? 'loading' : 'assigned';
    if (gross) return `Puts ${v} back to ${back} and sends these weights for approval.`;
    if (tare) return `Puts ${v} back to loading with this tare.`;
    return `Puts ${v} back to ${back} and marks it arrived.`;
  }
  if (gross) return `Sends these weights for ${v} to the office for approval.`;
  if (tare) return `Saves this tare and moves ${v} to loading.`;
  return `Marks ${v} arrived.`;
}

const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** "Restored by Rajesh", "Dismissed by Rajesh · Truck went back empty"; null while open. */
export function resolutionLine(r: Rejection): string | null {
  if (r.status === 'open') return null;
  const by = r.resolvedBy ? ` by ${first(r.resolvedBy.name)}` : '';
  if (r.status === 'restored') return `Restored${by}`;
  return `Dismissed${by}${r.resolutionNote ? ` · ${r.resolutionNote}` : ''}`;
}

export const firstName = first;
