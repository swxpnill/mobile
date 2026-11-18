import { roundHalfUp } from './money.ts';

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
  /**
   * IST date that sets an earning's place in "oldest paid first" (Ruling 7) when it differs from
   * `entryDate`: a correction's replacement earning counts on the correction day but keeps its
   * truck's dispatch day here.
   */
  fifoDate?: string;
  createdAt: string;
  reversesId: string | null;
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

type SideRow = Pick<LedgerRow, 'kind' | 'reversesId' | 'amountRupees'>;

/**
 * Whether a row is on the earnings side: an earning, or the reversal of one. `find` looks up the
 * reversed row; when it is gone, a reversal that lowers the due counts as an earning reversal.
 */
export function isEarningSide<R extends SideRow>(row: R, find: (id: string) => SideRow | undefined): boolean {
  if (row.kind === 'earning') return true;
  if (row.kind === 'payment') return false;
  const target = row.reversesId === null ? undefined : find(row.reversesId);
  return target ? target.kind === 'earning' : row.amountRupees <= 0;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byOrder(a: LedgerRow, b: LedgerRow): number {
  return cmp(a.entryDate, b.entryDate) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
}

function byFifo(a: LedgerRow, b: LedgerRow): number {
  return cmp(a.fifoDate ?? a.entryDate, b.fifoDate ?? b.entryDate) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
}

/**
 * Kg dispatched and not yet paid (Ruling 7): live payments settle live earnings oldest first (by
 * `fifoDate`, else `entryDate`); a
 * partly covered earning counts `roundHalfUp(uncovered x netKg, earning)` kg. Never negative.
 */
export function unpaidKg(rows: readonly LedgerRow[]): number {
  const reversed = new Set(rows.map((r) => r.reversesId).filter((x): x is string => x !== null));
  const live = rows.filter((r) => !reversed.has(r.id));
  let covered = -live.filter((r) => r.kind === 'payment').reduce((s, r) => s + r.amountRupees, 0);
  let kg = 0;
  for (const e of live.filter((r) => r.kind === 'earning').sort(byFifo)) {
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
    if (isEarningSide(r, (id) => byId.get(id))) earned += r.amountRupees;
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
