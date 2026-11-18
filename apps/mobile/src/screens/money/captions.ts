import {
  type LedgerEntry,
  PAYMENT_MODE_LABEL,
  type UnitBasis,
  formatRupees,
  toDisplayQty,
  toDisplayRate,
} from '@tonnage/shared';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "SO-2611-0142-A · CG 04 MK 2291" (the truck's sub-order and vehicle). */
const truckLabel = (e: LedgerEntry) => (e.truck ? `${e.truck.subOrderNumber} · ${e.truck.vehicleNo}` : '');

/**
 * Row title (board 06). `reversed` is the row a reversal undoes, when it is loaded: a payment's
 * reversal carries no mode of its own.
 */
export function ledgerTitle(e: LedgerEntry, reversed?: LedgerEntry): string {
  if (e.kind === 'earning') return truckLabel(e) || 'Earning';
  if (e.kind === 'payment') return e.payment ? `Payment · ${PAYMENT_MODE_LABEL[e.payment.mode]}` : 'Payment';
  if (e.truck) return `Weight corrected · ${truckLabel(e)}`;
  return reversed?.payment ? `Payment reversed · ${PAYMENT_MODE_LABEL[reversed.payment.mode]}` : 'Payment reversed';
}

/** "24.180 MT × (₹150 + ₹300 overprice)", "30.120 MT × ₹150 commission", "54.300 MT · 2 rates". */
function earningCaption(e: LedgerEntry, basis: UnitBasis): string {
  const kg = e.truck?.netKg ?? e.earningLines.reduce((s, l) => s + l.netKg, 0);
  const qty = toDisplayQty(Math.abs(kg), basis, { withUnit: true });
  const rates = new Map(e.earningLines.map((l) => [`${l.commissionPerMt}/${l.overpricePerMt}`, l]));
  if (rates.size > 1) return `${qty} · ${rates.size} rates`;
  const only = [...rates.values()][0];
  if (!only) return qty;
  const commission = toDisplayRate(only.commissionPerMt, basis);
  return only.overpricePerMt > 0
    ? `${qty} × (${commission} + ${toDisplayRate(only.overpricePerMt, basis)} overprice)`
    : `${qty} × ${commission} commission`;
}

/** The grey line under a ledger row's title (board 06). */
export function ledgerCaption(e: LedgerEntry, basis: UnitBasis): string {
  if (e.kind === 'earning') return earningCaption(e, basis);
  if (e.kind === 'payment') {
    const p = e.payment;
    const ref = p?.utr ? (p.mode === 'cheque' ? `Cheque no. ${p.utr}` : `UTR ${p.utr}`) : null;
    const tds = p && p.tdsRupees > 0 ? `TDS ${formatRupees(p.tdsRupees)}` : null;
    return [ref, tds, `recorded by ${firstName(e.createdBy.name)}`].filter(Boolean).join(' · ');
  }
  return e.truck ? 'Weight corrected' : (e.note ?? 'Reversed');
}

/** "+₹10,881" for the broker, "−₹40,000" against. */
export function signedRupees(n: number): string {
  return n > 0 ? `+${formatRupees(n)}` : formatRupees(n);
}
