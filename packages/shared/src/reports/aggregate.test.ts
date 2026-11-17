import { describe, expect, it } from 'vitest';
import { paymentAmount, type LedgerRow } from '../rules/ledger.ts';
import type { EarningLine } from '../rules/trucks.ts';
import { ageBucket, ageBucketLabels, ageDays, checkRange, istDate, monthOf } from './dates.ts';
import { buildReport, brokerWise, customerWise, dispatchRegister, loadingVariance, pendingOrders, productWise, unitSales, variancePercentTenths } from './aggregate.ts';
import { REPORT_ROW_CAP, type OpenSubOrderFact, type ReportFacts, type ReportFilter, type TruckLineFact } from './facts.ts';

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

describe('one rounding for lifted value', () => {
  // 1 kg and 3 kg at 500 per MT are 0.5 and 1.5 rupees: each line rounds half up (1 + 2)
  const lines = [
    line({ truckId: 'a', loadingSlipNo: 'LS-1', netKg: 1, ratePerMt: 500, overpricePerMt: 0 }),
    line({ truckId: 'b', loadingSlipNo: 'LS-2', netKg: 3, ratePerMt: 500, overpricePerMt: 0 }),
  ];
  it('register, unit-sales and customer-wise totals agree', () => {
    const fx = facts({ truckLines: lines });
    expect(dispatchRegister(fx, F).summary.valueRupees).toBe(3);
    expect(unitSales(fx, F).summary.valueRupees).toBe(3);
    expect(unitSales(fx, F).rows[0]!.valueRupees).toBe(3);
    expect(customerWise(fx, F).summary.liftedValueRupees).toBe(3);
  });
});

describe('age bucket labels follow the setting', () => {
  it('10 and 14', () => {
    expect(ageBucketLabels(10)).toEqual(['0–5', '6–10', '11–20', '21+']);
    expect(ageBucketLabels(14)).toEqual(['0–7', '8–14', '15–28', '29+']);
    expect(ageBucket(10, 10)).toBe('6–10');
    expect(ageBucket(11, 10)).toBe('11–20');
    expect(ageBucket(20, 10)).toBe('11–20');
    expect(ageBucket(15, 14)).toBe('15–28');
  });
});

describe('pending orders', () => {
  const so = (id: string, createdAt: string, pendingKg: number): OpenSubOrderFact => ({
    subOrderId: id,
    orderId: `o-${id}`,
    subOrderNumber: `SO-${id}`,
    companyId: 'c1',
    companyCode: 'AIS',
    customerId: 'cu1',
    customerName: 'Shree',
    createdAt,
    orderedKg: 30_000,
    dispatchedKg: 30_000 - pendingKg,
    pendingKg,
  });
  const open = [
    so('new', '2026-11-16T06:00:00Z', 5_000),
    so('old', '2026-10-01T06:00:00Z', 7_000),
    so('mid', '2026-11-03T06:00:00Z', 2_000),
    so('done', '2026-11-01T06:00:00Z', 0),
  ];
  it('drops zero pending, oldest first, buckets', () => {
    const r = pendingOrders(facts({ openSubOrders: open }), F);
    expect(r.rows.map((x) => x.subOrderId)).toEqual(['old', 'mid', 'new']);
    expect(r.rows.map((x) => x.ageDays)).toEqual([47, 14, 1]);
    expect(r.summary).toEqual({
      pendingKg: 14_000,
      subOrders: 3,
      byBucket: [
        { bucket: '0–5', pendingKg: 5_000, count: 1 },
        { bucket: '6–10', pendingKg: 0, count: 0 },
        { bucket: '11–20', pendingKg: 2_000, count: 1 },
        { bucket: '21+', pendingKg: 7_000, count: 1 },
      ],
    });
  });
  it('byBucket ignores the bucket filter while rows and totals follow it', () => {
    const r = pendingOrders(facts({ openSubOrders: open }), { ...F, bucket: '21+' });
    expect(r.rows.map((x) => x.subOrderId)).toEqual(['old']);
    expect(r.summary.pendingKg).toBe(7_000);
    expect(r.summary.byBucket.map((b) => b.count)).toEqual([1, 0, 1, 1]);
  });
  it('labels follow agedOrderDays', () => {
    const r = pendingOrders(facts({ openSubOrders: open }), { ...F, agedOrderDays: 14 });
    expect(r.summary.byBucket.map((b) => b.bucket)).toEqual(['0–7', '8–14', '15–28', '29+']);
  });
});

describe('unit sales', () => {
  it('per company and product, with totals', () => {
    const fx = facts({
      truckLines: [
        line({ truckId: 'a', netKg: 10_000, ratePerMt: 40_000, overpricePerMt: 0 }),
        line({ truckId: 'b', netKg: 5_000, ratePerMt: 40_000, overpricePerMt: 0 }),
        line({ truckId: 'c', companyId: 'c2', companyCode: 'BIS', companyName: 'B Ispat', netKg: 2_000, ratePerMt: 50_000, overpricePerMt: 0 }),
      ],
    });
    const r = unitSales(fx, F);
    expect(r.rows.map((x) => [x.companyCode, x.netKg, x.valueRupees, x.trucks])).toEqual([
      ['AIS', 15_000, 600_000, 2],
      ['BIS', 2_000, 100_000, 1],
    ]);
    expect(r.summary.netKg).toBe(17_000);
    expect(r.summary.valueRupees).toBe(700_000);
    expect(r.summary.byCompany.map((x) => [x.companyCode, x.netKg, x.valueRupees])).toEqual([
      ['AIS', 15_000, 600_000],
      ['BIS', 2_000, 100_000],
    ]);
  });
});

describe('customer-wise', () => {
  it('booked by order date, lifted by dispatch date, null customer grouped', () => {
    const fx = facts({
      bookedLines: [
        { orderId: 'o1', createdAt: '2026-11-02T06:00:00Z', companyId: 'c1', customerId: 'cu1', customerName: 'Shree', orderedKg: 30_000, valueRupees: 1_400_000 },
        { orderId: 'o0', createdAt: '2026-10-20T06:00:00Z', companyId: 'c1', customerId: 'cu1', customerName: 'Shree', orderedKg: 99_000, valueRupees: 9_000_000 },
        { orderId: 'o2', createdAt: '2026-11-03T06:00:00Z', companyId: 'c1', customerId: null, customerName: null, orderedKg: 1_000, valueRupees: 50_000 },
      ],
      truckLines: [
        line({ truckId: 'a', netKg: 10_000, ratePerMt: 40_000, overpricePerMt: 0 }),
        line({ truckId: 'b', customerId: null, customerName: null, netKg: 1_000, ratePerMt: 40_000, overpricePerMt: 0 }),
        line({ truckId: 'c', dispatchedAt: '2026-10-30T06:00:00Z', netKg: 7_000 }),
      ],
    });
    const r = customerWise(fx, F);
    expect(r.rows).toEqual([
      { customerId: 'cu1', customerName: 'Shree', bookedKg: 30_000, bookedValueRupees: 1_400_000, liftedKg: 10_000, liftedValueRupees: 400_000 },
      { customerId: null, customerName: null, bookedKg: 1_000, bookedValueRupees: 50_000, liftedKg: 1_000, liftedValueRupees: 40_000 },
    ]);
    expect(r.summary).toEqual({ bookedKg: 31_000, bookedValueRupees: 1_450_000, liftedKg: 11_000, liftedValueRupees: 440_000 });
  });
});

describe('product-wise', () => {
  it('groups by product, size and length with distinct trucks', () => {
    const r = productWise(
      facts({
        truckLines: [
          line({ truckId: 'a', netKg: 10_000 }),
          line({ truckId: 'a', netKg: 2_000 }),
          line({ truckId: 'b', netKg: 5_000 }),
          line({ truckId: 'c', sizeLabel: '16 mm', netKg: 3_000 }),
        ],
      }),
      F,
    );
    expect(r.rows.map((x) => [x.sizeLabel, x.netKg, x.trucks])).toEqual([
      ['12 mm', 17_000, 2],
      ['16 mm', 3_000, 1],
    ]);
    expect(r.summary).toEqual({ netKg: 20_000, trucks: 3 });
  });
});

describe('loading variance summary', () => {
  it('over and under trucks and kg do not net to zero', () => {
    const r = loadingVariance(
      facts({
        truckLines: [
          line({ truckId: 'a', vehicleNo: 'A', plannedKg: 24_000, netKg: 24_180 }),
          line({ truckId: 'b', vehicleNo: 'B', plannedKg: 30_000, netKg: 29_580 }),
          line({ truckId: 'c', vehicleNo: 'C', plannedKg: 10_000, netKg: 10_000 }),
          line({ truckId: 'd', vehicleNo: 'D', plannedKg: 20_000, netKg: 20_050 }),
        ],
      }),
      F,
    );
    expect(r.rows.map((x) => x.diffKg)).toEqual([180, -420, 0, 50]);
    expect(r.summary).toEqual({ trucks: 4, overTrucks: 2, underTrucks: 1, overKg: 230, underKg: 420 });
  });
});
