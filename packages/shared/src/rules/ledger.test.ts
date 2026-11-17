import { describe, expect, it } from 'vitest';
import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABEL,
  UTR_REQUIRED,
  brokerDue,
  dueAfterPayment,
  dueState,
  halfOf,
  isLiveRow,
  monthTotals,
  paymentAmount,
  statementTotals,
  unpaidKg,
  type LedgerRow,
} from './ledger.ts';

function earning(id: string, amountRupees: number, netKg: number, entryDate: string): LedgerRow {
  return { id, kind: 'earning', amountRupees, netKg, entryDate, createdAt: `${entryDate}T06:00:00.000Z`, reversesId: null };
}
function payment(id: string, amountRupees: number, entryDate: string): LedgerRow {
  return { id, kind: 'payment', amountRupees, netKg: 0, entryDate, createdAt: `${entryDate}T08:00:00.000Z`, reversesId: null };
}
function reversal(id: string, of: LedgerRow, entryDate: string): LedgerRow {
  return {
    id,
    kind: 'reversal',
    amountRupees: -of.amountRupees,
    netKg: -of.netKg,
    entryDate,
    createdAt: `${entryDate}T09:00:00.000Z`,
    reversesId: of.id,
  };
}

const A = earning('a', 10_881, 24_180, '2026-11-01'); // 24.180 MT × (₹150 + ₹300)
const B = earning('b', 4_518, 30_120, '2026-11-02'); // 30.120 MT × ₹150
const P = payment('p', paymentAmount(10_000, 500), '2026-11-03'); // −10,500

describe('ledger', () => {
  it('payment modes', () => {
    expect(PAYMENT_MODES).toEqual(['neft', 'upi', 'cash', 'cheque']);
    expect([...UTR_REQUIRED].sort()).toEqual(['neft', 'upi']);
    expect(PAYMENT_MODE_LABEL).toEqual({ neft: 'NEFT', upi: 'UPI', cash: 'Cash', cheque: 'Cheque' });
  });
  it('payment amount is −(paid + tds)', () => expect(P.amountRupees).toBe(-10_500));
  it('due is the signed sum: 15,399 − 10,500 = 4,899', () => expect(brokerDue([A, B, P])).toBe(4_899));
  it('FIFO unpaid: A is ₹381 short → 847 kg, B unpaid 30,120 → 30,967', () => expect(unpaidKg([A, B, P])).toBe(30_967));
  it('an advance leaves 0 unpaid kg, never negative', () => expect(unpaidKg([A, payment('q', -20_000, '2026-11-03')])).toBe(0));
  it('a reversed payment no longer settles anything', () => {
    expect(unpaidKg([A, B, P, reversal('r', P, '2026-11-04')])).toBe(54_300);
  });
  it('a reversed earning is not counted', () => {
    expect(unpaidKg([A, reversal('r', A, '2026-11-04'), B])).toBe(30_120);
  });
  it('canvas: due ₹86,400, pay ₹40,000 → ₹46,400; Half of 86,400 / 86,401', () => {
    expect(dueAfterPayment(86_400, 40_000, 0)).toBe(46_400);
    expect(dueAfterPayment(86_400, 40_000, 2_000)).toBe(44_400);
    expect(halfOf(86_400)).toBe(43_200);
    expect(halfOf(86_401)).toBe(43_201);
    expect(halfOf(-5)).toBe(0);
    expect(halfOf(0)).toBe(0);
  });
  it('dueState: −4,601 → advance 4,601; 0 → clear', () => {
    expect(dueState(-4_601)).toEqual({ kind: 'advance', rupees: 4_601 });
    expect(dueState(0)).toEqual({ kind: 'clear', rupees: 0 });
    expect(dueState(4_899)).toEqual({ kind: 'due', rupees: 4_899 });
  });
  it('isLiveRow: no reversal points at it', () => {
    const rows = [A, B, P, reversal('r', P, '2026-11-04')];
    expect(isLiveRow(rows, P)).toBe(false);
    expect(isLiveRow(rows, A)).toBe(true);
  });
  it('monthTotals Nov: earned 15,399, paid 10,500', () => {
    expect(monthTotals([A, B, P], '2026-11')).toEqual({ earnedRupees: 15_399, paidRupees: 10_500 });
    expect(monthTotals([A, B, P], '2026-10')).toEqual({ earnedRupees: 0, paidRupees: 0 });
  });
  it('a payment reversal lowers paid in its month', () => {
    const rows = [A, P, reversal('r', P, '2026-12-02')];
    expect(monthTotals(rows, '2026-11').paidRupees).toBe(10_500);
    expect(monthTotals(rows, '2026-12').paidRupees).toBe(-10_500);
  });
  it('statement 1–30 Nov with an October earning: opening = October due', () => {
    const oct = earning('o', 2_000, 10_000, '2026-10-20');
    const s = statementTotals([oct, B, A, P], '2026-11-01', '2026-11-30');
    expect(s.openingDueRupees).toBe(2_000);
    expect(s.earnedRupees).toBe(15_399);
    expect(s.paidRupees).toBe(10_500);
    expect(s.closingDueRupees).toBe(6_899);
    expect(s.inRange.map((r) => r.id)).toEqual(['a', 'b', 'p']);
  });
  it('weight correction in Nov of an Oct truck lowers Nov earned (reversal counts on its date)', () => {
    const oct = earning('o', 10_881, 24_180, '2026-10-30');
    const rev = reversal('r', oct, '2026-11-05');
    const fixed = earning('f', 9_900, 22_000, '2026-11-05');
    expect(monthTotals([oct, rev, fixed], '2026-10').earnedRupees).toBe(10_881);
    expect(monthTotals([oct, rev, fixed], '2026-11').earnedRupees).toBe(-981);
    expect(brokerDue([oct, rev, fixed])).toBe(9_900);
  });
});
