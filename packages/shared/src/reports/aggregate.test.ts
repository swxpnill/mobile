import { describe, expect, it } from 'vitest';
import { paymentAmount, type LedgerRow } from '../rules/ledger.ts';
import type { EarningLine } from '../rules/trucks.ts';
import { ageBucket, ageDays, checkRange, istDate, monthOf } from './dates.ts';
import { buildReport, dispatchRegister, brokerWise, loadingVariance, variancePercentTenths } from './aggregate.ts';
import { REPORT_ROW_CAP, type ReportFacts, type ReportFilter, type TruckLineFact } from './facts.ts';

function line(over: Partial<TruckLineFact> = {}): TruckLineFact {
  return {
    truckId: 't1',
    dispatchedAt: '2026-11-05T06:00:00Z',
    companyId: 'c1',
    companyCode: 'AIS',
    companyName: 'Agrawal Ispat',
    plantId: 'p1',
    plantName: 'Siltara',
    orderId: 'o1',
    orderNumber: 'SO-2611-0001',
    subOrderNumber: 'SO-2611-0001-A',
    customerId: 'cu1',
    customerName: 'Shree Traders',
    brokerId: 'b1',
    brokerName: 'Mohan',
    vehicleNo: 'CG04AB1234',
    loadingSlipNo: 'LS-AIS-2611-0001',
    productId: 'pr1',
    productName: 'TMT',
    sizeLabel: '12 mm',
    lengthValue: 12,
    lengthUnit: 'm',
    plannedKg: 24_000,
    netKg: 24_100,
    ratePerMt: 46_305,
    overpricePerMt: 300,
    ...over,
  };
}

const F: ReportFilter = { from: '2026-11-01', to: '2026-11-17', today: '2026-11-17', agedOrderDays: 10 };
function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return { truckLines: [], openSubOrders: [], bookedLines: [], brokers: [], ...over };
}

describe('dates', () => {
  it('IST day boundary', () => {
    expect(istDate('2026-10-31T18:20:00Z')).toBe('2026-10-31');
    expect(istDate('2026-10-31T18:30:00Z')).toBe('2026-11-01');
    expect(monthOf('2026-11-05')).toBe('2026-11');
  });
  it('23:50 IST truck is in October, not November', () => {
    const f = facts({ truckLines: [line({ dispatchedAt: '2026-10-31T18:20:00Z' })] });
    expect(dispatchRegister(f, { ...F, from: '2026-10-01', to: '2026-10-31' }).rows).toHaveLength(1);
    expect(dispatchRegister(f, { ...F, from: '2026-11-01', to: '2026-11-17' }).rows).toHaveLength(0);
  });
  it('checkRange', () => {
    expect(checkRange('2026-11-17', '2026-11-01', '2026-11-17')).toBe('ORDER');
    expect(checkRange('2025-11-16', '2026-11-17', '2026-11-17')).toBe('TOO_LONG');
    expect(checkRange('2026-11-01', '2026-11-18', '2026-11-17')).toBe('FUTURE');
    expect(checkRange('2025-11-17', '2026-11-17', '2026-11-17')).toBe('ok');
  });
  it('age buckets', () => {
    expect(ageDays('2026-11-03T04:30:00Z', '2026-11-17')).toBe(14);
    expect(ageBucket(14, 10)).toBe('11–20');
    expect(ageBucket(5, 10)).toBe('0–5');
    expect(ageBucket(6, 10)).toBe('6–10');
    expect(ageBucket(21, 10)).toBe('21+');
  });
});

describe('dispatch register', () => {
  it('values at the billed rate, half up', () => {
    const r = dispatchRegister(
      facts({
        truckLines: [
          line({ truckId: 'a', loadingSlipNo: 'LS-1' }),
          line({ truckId: 'b', loadingSlipNo: 'LS-2', netKg: 24_180, ratePerMt: 46_300 }),
        ],
      }),
      F,
    );
    expect(r.rows.map((x) => x.valueRupees)).toEqual([1_123_181, 1_126_788]);
    expect(r.summary.valueRupees).toBe(2_249_969);
  });
  it('summary over/under and per company', () => {
    const lines = [
      line({ truckId: 'a', plannedKg: 24_000, netKg: 24_180 }),
      line({ truckId: 'b', companyId: 'c2', companyCode: 'BIS', companyName: 'B Ispat', plannedKg: 30_000, netKg: 29_700 }),
    ];
    const r = dispatchRegister(facts({ truckLines: lines }), F);
    expect(r.summary.overUnderKg).toBe(-120);
    expect(r.summary.byCompany).toHaveLength(2);
    expect(dispatchRegister(facts({ truckLines: lines }), { ...F, companyId: 'c2' }).summary.byCompany).toHaveLength(1);
  });
  it('caps rows but summarises all', () => {
    const lines = Array.from({ length: REPORT_ROW_CAP + 1 }, (_, i) => line({ truckId: `t${i}`, loadingSlipNo: `LS-${i}` }));
    const r = dispatchRegister(facts({ truckLines: lines }), F);
    expect(r.rows).toHaveLength(REPORT_ROW_CAP);
    expect(r.truncated).toBe(true);
    expect(r.summary.trucks).toBe(REPORT_ROW_CAP + 1);
  });
});

describe('broker-wise', () => {
  const el = (netKg: number, commissionPerMt: number, overpricePerMt: number): EarningLine => ({
    orderLineId: 'l',
    netKg,
    perMt: commissionPerMt + overpricePerMt,
    commissionPerMt,
    overpricePerMt,
  });
  const row = (id: string, kind: LedgerRow['kind'], amountRupees: number, netKg: number, entryDate: string, earningLines: EarningLine[]) => ({
    id,
    kind,
    amountRupees,
    netKg,
    entryDate,
    createdAt: `${entryDate}T06:00:00.000Z`,
    reversesId: null,
    earningLines,
  });
  it('splits commission and overprice and closes the due', () => {
    const rows = [
      row('a', 'earning', 10_881, 24_180, '2026-11-01', [el(24_180, 150, 300)]),
      row('b', 'earning', 4_518, 30_120, '2026-11-02', [el(30_120, 150, 0)]),
      row('p', 'payment', paymentAmount(10_000, 500), 0, '2026-11-03', []),
    ];
    const r = brokerWise(facts({ brokers: [{ brokerId: 'b1', brokerName: 'Mohan', rows }] }), F);
    expect(r.rows).toEqual([
      {
        brokerId: 'b1',
        brokerName: 'Mohan',
        netKg: 54_300,
        commissionRupees: 8_145,
        overpriceRupees: 7_254,
        earnedRupees: 15_399,
        paidRupees: 10_500,
        dueRupees: 4_899,
      },
    ]);
  });
});

describe('variance and dispatch', () => {
  it('percent in tenths', () => {
    expect(variancePercentTenths(180, 24_000)).toBe(8);
    expect(variancePercentTenths(-420, 24_000)).toBe(-18);
    expect(variancePercentTenths(5, 0)).toBeNull();
  });
  it('per truck, lines summed', () => {
    const r = loadingVariance(
      facts({ truckLines: [line({ plannedKg: 10_000, netKg: 10_100 }), line({ plannedKg: 14_000, netKg: 13_900 })] }),
      F,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ plannedKg: 24_000, netKg: 24_000, diffKg: 0 });
  });
  it('buildReport dispatches', () => {
    expect(buildReport('product-wise', facts({ truckLines: [line()] }), F).kind).toBe('product-wise');
  });
});
