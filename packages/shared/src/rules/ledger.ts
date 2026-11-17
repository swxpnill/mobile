import { roundHalfUp } from './money.ts';
import { istDateParts } from './numbering.ts';

export const PAYMENT_MODES = ['neft', 'upi', 'cash', 'cheque'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Modes that must carry a UTR (§5.4); cash and cheque may carry an optional reference. */
export const UTR_REQUIRED: ReadonlySet<PaymentMode> = new Set<PaymentMode>(['neft', 'upi']);

export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  neft: 'NEFT',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
};

export interface LedgerRow {
  id: string;
  kind: 'earning' | 'payment' | 'reversal';
  /** Signed in the broker's favour: earning +, payment -(paid + tds), reversal the exact negation. */
  amountRupees: number;
  /** Sum of the earning's breakdown (0 for payments, negative for an earning's reversal). */
  netKg: number;
  /** IST date `YYYY-MM-DD` the row counts on. */
  entryDate: string;
  createdAt: string;
  reversesId: string | null;
}

/** IST `YYYY-MM-DD` of an instant. */
export function istDateOf(at: string | number): string {
  const { year, month, day } = istDateParts(at);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function paymentAmount(paidRupees: number, tdsRupees: number): number {
  return -(paidRupees + tdsRupees);
}

export function brokerDue(rows: readonly LedgerRow[]): number {
  return rows.reduce((s, r) => s + r.amountRupees, 0);
}

export function dueAfterPayment(dueRupees: number, paidRupees: number, tdsRupees: number): number {
  return dueRupees - paidRupees - tdsRupees;
}

/** The "Half" shortcut: half the due rounded half up; nothing when there is no due. */
export function halfOf(dueRupees: number): number {
  return dueRupees > 0 ? roundHalfUp(dueRupees, 2) : 0;
}

export function dueState(dueRupees: number): { kind: 'due' | 'advance' | 'clear'; rupees: number } {
  if (dueRupees > 0) return { kind: 'due', rupees: dueRupees };
  if (dueRupees < 0) return { kind: 'advance', rupees: -dueRupees };
  return { kind: 'clear', rupees: 0 };
}

export function isLiveRow(rows: readonly LedgerRow[], row: LedgerRow): boolean {
  return !rows.some((r) => r.reversesId === row.id);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byOrder(a: LedgerRow, b: LedgerRow): number {
  return cmp(a.entryDate, b.entryDate) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
}

/**
 * Kg dispatched and not yet paid (Ruling 7): live payments settle live earnings oldest first; a
 * partly covered earning counts `roundHalfUp(uncovered x netKg, earning)` kg. Never negative.
 */
export function unpaidKg(rows: readonly LedgerRow[]): number {
  const reversed = new Set(rows.map((r) => r.reversesId).filter((x): x is string => x !== null));
  const live = rows.filter((r) => !reversed.has(r.id));
  let covered = -live.filter((r) => r.kind === 'payment').reduce((s, r) => s + r.amountRupees, 0);
  let kg = 0;
  for (const e of live.filter((r) => r.kind === 'earning').sort(byOrder)) {
    if (e.amountRupees <= 0) continue;
    if (covered >= e.amountRupees) {
      covered -= e.amountRupees;
      continue;
    }
    const uncovered = e.amountRupees - Math.max(covered, 0);
    covered = 0;
    kg += roundHalfUp(uncovered * e.netKg, e.amountRupees);
  }
  return kg;
}

function split(rows: readonly LedgerRow[], inRange: readonly LedgerRow[]): { earnedRupees: number; paidRupees: number } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let earned = 0;
  let paid = 0;
  for (const r of inRange) {
    let isEarning = r.kind === 'earning';
    if (r.kind === 'reversal') {
      const target = r.reversesId === null ? undefined : byId.get(r.reversesId);
      isEarning = target ? target.kind === 'earning' : r.amountRupees <= 0;
    }
    if (isEarning) earned += r.amountRupees;
    else paid -= r.amountRupees;
  }
  return { earnedRupees: earned, paidRupees: paid };
}

/** Earned (earnings + earning reversals) and paid (-(payments + payment reversals)) in an IST month. */
export function monthTotals(rows: readonly LedgerRow[], month: string): { earnedRupees: number; paidRupees: number } {
  return split(
    rows,
    rows.filter((r) => r.entryDate.startsWith(`${month}-`)),
  );
}

export function statementTotals(
  rows: readonly LedgerRow[],
  from: string,
  to: string,
): { openingDueRupees: number; earnedRupees: number; paidRupees: number; closingDueRupees: number; inRange: LedgerRow[] } {
  const inRange = rows.filter((r) => r.entryDate >= from && r.entryDate <= to).sort(byOrder);
  const openingDueRupees = brokerDue(rows.filter((r) => r.entryDate < from));
  const { earnedRupees, paidRupees } = split(rows, inRange);
  return { openingDueRupees, earnedRupees, paidRupees, closingDueRupees: openingDueRupees + brokerDue(inRange), inRange };
}
