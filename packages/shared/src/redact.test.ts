import { expect, it } from 'vitest';
import { MONEY_KEYS, redactForRole } from './redact.ts';

const p = { id: 'o1', qtyKg: 24180, rate: 46300, lines: [{ amount: 5, x: 1 }], nested: { due: 9 } };
it('omits money keys for plant_head and supervisor', () => {
  expect(redactForRole('supervisor', p)).toEqual({ id: 'o1', qtyKg: 24180, lines: [{ x: 1 }], nested: {} });
  expect(redactForRole('plant_head', p)).toEqual(redactForRole('supervisor', p));
});
it('leaves other roles unchanged', () => {
  expect(redactForRole('owner', p)).toEqual(p);
  expect(redactForRole('city_staff', p)).toEqual(p);
});
it('does not mutate input', () => {
  redactForRole('supervisor', p);
  expect(p.rate).toBe(46300);
  expect(p.lines[0]).toEqual({ amount: 5, x: 1 });
});
it('handles arrays and primitives', () => {
  expect(redactForRole('supervisor', [{ rate: 1, a: 2 }, 3, null])).toEqual([{ a: 2 }, 3, null]);
  expect(redactForRole('supervisor', 5)).toBe(5);
  expect(redactForRole('supervisor', null)).toBeNull();
  expect('rate' in (redactForRole('supervisor', { rate: null }) as object)).toBe(false);
});
it('passes Date and other non-plain objects through untouched', () => {
  const d0 = new Date(0);
  const d5 = new Date(5);
  const out = redactForRole('supervisor', { at: d0, rate: 1, nested: { d: d5 } }) as {
    at: Date; rate?: number; nested: { d: Date };
  };
  expect(out.at).toBe(d0);
  expect(out.nested.d).toBe(d5);
  expect('rate' in out).toBe(false);
});
it('F2: order estimates are money; quantity totals are not', () => {
  const order = {
    estimatedValue: 3_864_200,
    brokerEarningEstimate: { commission: 12_600, overprice: 22_200, total: 34_800 },
    totals: { pendingKg: 84_000, total: 4 },
  };
  expect(redactForRole('plant_head', order)).toEqual({ totals: { pendingKg: 84_000, total: 4 } });
});

it('F2: generic names are not money — a line length keeps its value for plant heads', () => {
  const line = { length: { value: 12, unit: 'm' }, valueRupees: 5, lineValue: 7 };
  expect(redactForRole('plant_head', line)).toEqual({ length: { value: 12, unit: 'm' } });
});
it('strips earning keys for plant roles', () => {
  expect(redactForRole('plant_head', { earningRupees: 1, breakdown: [] })).toEqual({});
});
it('strips billedRate for plant heads and supervisors', () => {
  const row = { truckId: 't1', netKg: 24100, billedRate: 46605, valueRupees: 5 };
  expect(redactForRole('plant_head', row)).toEqual({ truckId: 't1', netKg: 24100 });
  expect(redactForRole('owner', row)).toEqual(row);
});

it('F4: ledger, payment and report money keys are stripped for plant heads and supervisors', () => {
  expect(redactForRole('plant_head', { dueRupees: 1, earningLines: [], payment: {} })).toEqual({});
  const payload = {
    summary: { dueRupees: 1, earnedThisMonthRupees: 2, paidThisMonthRupees: 3, unpaidKg: 400 },
    totalDueRupees: 5,
    openingDueRupees: 6,
    closingDueRupees: 7,
    earnedRupees: 8,
    paidRupees: 9,
    commissionRupees: 10,
    overpriceRupees: 11,
    bookedValueRupees: 12,
    liftedValueRupees: 13,
    netKg: 1000,
    items: [{ id: 'a', perMt: 450, kind: 'earning', amountRupees: 1 }],
  };
  expect(redactForRole('supervisor', payload)).toEqual({ summary: { unpaidKg: 400 }, netKg: 1000, items: [{ id: 'a', kind: 'earning' }] });
  expect(redactForRole('owner', payload)).toEqual(payload);
});

it('F4: no non-money field name is on the money list', () => {
  for (const k of ['id', 'name', 'netKg', 'unpaidKg', 'kind', 'entryDate', 'createdAt', 'utr', 'mode', 'paidOn', 'note', 'lines', 'truck', 'productName', 'reversesId', 'reversedById']) {
    expect(MONEY_KEYS.has(k)).toBe(false);
  }
});
