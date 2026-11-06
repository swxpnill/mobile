import type { Role } from '../roles.ts';

export interface EditLineExisting {
  lineId: string;
  /** Product and length together ("productId|12m"): what the line is. */
  productKey: string;
  orderedKg: number;
  rate: number;
  overpricePerMt: number;
  dispatchedKg: number;
  reservedKg: number;
  /** The line's sub-order is completed, short closed or cancelled. */
  terminal: boolean;
}

export interface EditLineDesired {
  /** Absent for a new line. */
  lineId?: string;
  productKey: string;
  orderedKg: number;
  rate: number;
  overpricePerMt: number;
  /** The sub-order the line goes into is terminal. */
  terminal: boolean;
}

export type EditErrorCode =
  | 'BELOW_DISPATCHED'
  | 'LINE_RATE_LOCKED'
  | 'LINE_HAS_DISPATCHES'
  | 'ORDER_LOCKED'
  | 'LINE_NOT_ON_ORDER';

export interface EditPlan {
  errors: { lineId?: string; code: EditErrorCode }[];
  warnings: { lineId: string; code: 'BELOW_RESERVED' }[];
}

/**
 * Who may change what once dispatch has started (§5.3). Everyone: never below dispatched, never
 * remove or re-product a line with dispatches, never touch a closed sub-order (reopen first).
 * City staff additionally cannot change the rate or overprice of a line with dispatches (owner
 * can; earlier trucks keep their snapshot earnings either way, §5.4). Below dispatched + reserved
 * is a warning only.
 */
export function planOrderEdit(input: {
  role: Role;
  existing: readonly EditLineExisting[];
  desired: readonly EditLineDesired[];
}): EditPlan {
  const plan: EditPlan = { errors: [], warnings: [] };
  const byId = new Map(input.existing.map((l) => [l.lineId, l]));
  const kept = new Set<string>();
  const isOwner = input.role === 'owner';

  for (const d of input.desired) {
    if (d.lineId === undefined) {
      if (d.terminal) plan.errors.push({ code: 'ORDER_LOCKED' });
      continue;
    }
    const e = byId.get(d.lineId);
    if (!e) {
      plan.errors.push({ lineId: d.lineId, code: 'LINE_NOT_ON_ORDER' });
      continue;
    }
    kept.add(e.lineId);
    const productChanged = d.productKey !== e.productKey;
    const priceChanged = d.rate !== e.rate || d.overpricePerMt !== e.overpricePerMt;
    const changed = productChanged || priceChanged || d.orderedKg !== e.orderedKg;
    if (!changed) continue;
    if (e.terminal) {
      plan.errors.push({ lineId: e.lineId, code: 'ORDER_LOCKED' });
      continue;
    }
    if (e.dispatchedKg > 0 && productChanged) {
      plan.errors.push({ lineId: e.lineId, code: 'LINE_HAS_DISPATCHES' });
      continue;
    }
    if (d.orderedKg < e.dispatchedKg) plan.errors.push({ lineId: e.lineId, code: 'BELOW_DISPATCHED' });
    if (e.dispatchedKg > 0 && priceChanged && !isOwner) {
      plan.errors.push({ lineId: e.lineId, code: 'LINE_RATE_LOCKED' });
    }
    if (d.orderedKg >= e.dispatchedKg && d.orderedKg < e.dispatchedKg + e.reservedKg) {
      plan.warnings.push({ lineId: e.lineId, code: 'BELOW_RESERVED' });
    }
  }

  for (const e of input.existing) {
    if (kept.has(e.lineId)) continue;
    if (e.terminal) plan.errors.push({ lineId: e.lineId, code: 'ORDER_LOCKED' });
    else if (e.dispatchedKg > 0) plan.errors.push({ lineId: e.lineId, code: 'LINE_HAS_DISPATCHES' });
  }
  return plan;
}
