import { describe, expect, it } from 'vitest';
import { type Report, reportQuerySchema, reportSchema } from '../index.ts';

// Compile-time: the schema's output and the aggregators' Report are the same shape both ways.
type Out = ReturnType<typeof reportSchema.parse>;
export const asSchema = (r: Report): Out => r;
export const asReport = (r: Out): Report => r;

const loadingVariance = {
  kind: 'loading-variance',
  from: '2026-11-01',
  to: '2026-11-17',
  truncated: false,
  rows: [],
  summary: { trucks: 0, overTrucks: 0, underTrucks: 0, overKg: 0, underKg: 0 },
};

describe('reportSchema', () => {
  it('accepts a report and refuses an extra key, at the top and in a summary', () => {
    expect(reportSchema.safeParse(loadingVariance).success).toBe(true);
    expect(reportSchema.safeParse({ ...loadingVariance, extra: 1 }).success).toBe(false);
    expect(reportSchema.safeParse({ ...loadingVariance, summary: { ...loadingVariance.summary, extra: 1 } }).success).toBe(false);
  });
  it('refuses an unknown kind', () => {
    expect(reportSchema.safeParse({ ...loadingVariance, kind: 'nope' }).success).toBe(false);
  });
  it('accepts every kind with an empty body', () => {
    const empty = {
      'dispatch-register': { netKg: 0, trucks: 0, overUnderKg: 0, valueRupees: 0, byCompany: [] },
      'pending-orders': { pendingKg: 0, subOrders: 0, byBucket: [] },
      'unit-sales': { netKg: 0, valueRupees: 0, byCompany: [] },
      'broker-wise': { netKg: 0, commissionRupees: 0, overpriceRupees: 0, earnedRupees: 0, paidRupees: 0, dueRupees: 0 },
      'customer-wise': { bookedKg: 0, bookedValueRupees: 0, liftedKg: 0, liftedValueRupees: 0 },
      'product-wise': { netKg: 0, trucks: 0 },
    } as const;
    for (const [kind, summary] of Object.entries(empty)) {
      expect(reportSchema.safeParse({ kind, from: '2026-11-01', to: '2026-11-17', truncated: false, rows: [], summary }).success).toBe(true);
    }
  });
});

describe('reportQuerySchema', () => {
  it('needs from and to; filters are optional', () => {
    expect(reportQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-17' }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ from: '2026-11-01' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-17', bucket: '6–10' }).success).toBe(true);
  });
});
