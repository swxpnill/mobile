import { describe, expect, it } from 'vitest';
import {
  brokerStatementQuerySchema,
  isoDateSchema,
  ledgerEntrySchema,
  ledgerQuerySchema,
  recordPaymentBodySchema,
  reverseEntryBodySchema,
} from '../index.ts';

const base = { paidRupees: 500, mode: 'neft', utr: 'UTR223614', paidOn: '2026-11-16' } as const;

describe('recordPaymentBodySchema', () => {
  it('refuses NEFT and UPI without a UTR (path utr)', () => {
    for (const mode of ['neft', 'upi'] as const) {
      const r = recordPaymentBodySchema.safeParse({ ...base, mode, utr: null });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('utr');
    }
  });
  it('accepts cash and cheque with no reference, and trims a UTR', () => {
    expect(recordPaymentBodySchema.parse({ ...base, mode: 'cash', utr: null })).toMatchObject({ utr: null, tdsRupees: 0 });
    expect(recordPaymentBodySchema.parse({ ...base, utr: '  ab12cd ' }).utr).toBe('ab12cd');
  });
  it('refuses a malformed UTR and TDS above the payment (path tdsRupees)', () => {
    expect(recordPaymentBodySchema.safeParse({ ...base, utr: 'ab' }).success).toBe(false);
    expect(recordPaymentBodySchema.safeParse({ ...base, utr: 'AB-12345' }).success).toBe(false);
    const r = recordPaymentBodySchema.safeParse({ ...base, tdsRupees: 501 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('tdsRupees');
    expect(recordPaymentBodySchema.safeParse({ ...base, tdsRupees: 500 }).success).toBe(true);
  });
  it('bounds the amount and the date shape', () => {
    expect(recordPaymentBodySchema.safeParse({ ...base, paidRupees: 0 }).success).toBe(false);
    expect(recordPaymentBodySchema.safeParse({ ...base, paidRupees: 100_000_001 }).success).toBe(false);
    expect(recordPaymentBodySchema.safeParse({ ...base, paidRupees: 1.5 }).success).toBe(false);
    expect(recordPaymentBodySchema.safeParse({ ...base, paidOn: '16/11/2026' }).success).toBe(false);
  });
});

describe('other money schemas', () => {
  it('reverse reason is 3 to 200 characters', () => {
    expect(reverseEntryBodySchema.safeParse({ reason: 'ab' }).success).toBe(false);
    expect(reverseEntryBodySchema.safeParse({ reason: 'Wrong broker' }).success).toBe(true);
    expect(reverseEntryBodySchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
  });
  it('ledger query defaults to view all, limit 50', () => {
    expect(ledgerQuerySchema.parse({})).toEqual({ view: 'all', limit: 50 });
    expect(ledgerQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it('statement query needs from and to dates', () => {
    expect(brokerStatementQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-17' }).success).toBe(true);
    expect(brokerStatementQuerySchema.safeParse({ from: '2026-11-01' }).success).toBe(false);
  });
  it('a ledger entry is strict', () => {
    const entry = {
      id: '019a4c00-0000-7000-8000-000000000001',
      kind: 'payment',
      amountRupees: -500,
      entryDate: '2026-11-16',
      createdAt: '2026-11-16T05:00:00.000Z',
      createdBy: { id: '019a4c00-0000-7000-8000-000000000002', name: 'Rajesh' },
      truck: null,
      earningLines: [],
      payment: { mode: 'neft', utr: 'UTR223614', paidRupees: 500, tdsRupees: 0, paidOn: '2026-11-16' },
      reversesId: null,
      reversedById: null,
      note: null,
    };
    expect(ledgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(ledgerEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
  });
});

describe('isoDateSchema', () => {
  it('refuses impossible calendar dates, keeps real ones', () => {
    expect(isoDateSchema.safeParse('2026-02-31').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-13-01').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-00-10').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-04-31').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-11-30').success).toBe(true);
    expect(recordPaymentBodySchema.safeParse({ ...base, paidOn: '2026-02-31' }).success).toBe(false);
  });
});
