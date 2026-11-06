/** One order line's quantities, all integer kg (§5.1). */
export interface LineQty {
  orderedKg: number;
  /** Σ net over dispatched trucks. */
  dispatchedKg: number;
  /** Set by a short close or tolerance close. */
  closedKg: number;
  /** Σ planned kg over trucks still assigned, at the gate or loading. */
  reservedKg: number;
}

export interface QtyTotals {
  orderedKg: number;
  dispatchedKg: number;
  closedKg: number;
  reservedKg: number;
  pendingKg: number;
  overKg: number;
}

export function pending(l: LineQty): number {
  return Math.max(0, l.orderedKg - l.dispatchedKg - l.closedKg);
}

export function over(l: LineQty): number {
  return Math.max(0, l.dispatchedKg - l.orderedKg);
}

/** Pending not yet planned on a truck. Negative means over-planned: a warning, never a block. */
export function assignable(l: LineQty): number {
  return pending(l) - l.reservedKg;
}

/** Sums line by line: pending and over are per line, never netted across lines (§5.1). */
export function totalsOf(lines: readonly LineQty[]): QtyTotals {
  const t: QtyTotals = {
    orderedKg: 0,
    dispatchedKg: 0,
    closedKg: 0,
    reservedKg: 0,
    pendingKg: 0,
    overKg: 0,
  };
  for (const l of lines) {
    t.orderedKg += l.orderedKg;
    t.dispatchedKg += l.dispatchedKg;
    t.closedKg += l.closedKg;
    t.reservedKg += l.reservedKg;
    t.pendingKg += pending(l);
    t.overKg += over(l);
  }
  return t;
}
