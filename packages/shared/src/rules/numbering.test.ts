import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  financialYear,
  formatOrderNumber,
  istDateParts,
  subOrderNumber,
  subOrderSuffix,
} from './numbering.ts';

describe('istDateParts', () => {
  it('uses IST (+05:30), not UTC: 31 Oct 19:00 UTC is already 1 Nov in India', () => {
    expect(istDateParts('2026-10-31T19:00:00Z')).toEqual({ year: 2026, month: 11, day: 1 });
    expect(istDateParts(Date.UTC(2026, 9, 31, 18, 29))).toEqual({ year: 2026, month: 10, day: 31 });
  });

  it('rejects an unparseable date instead of numbering it as NaN', () => {
    expect(() => istDateParts('not a date')).toThrow(RangeError);
  });
});

describe('financialYear (1 Apr – 31 Mar IST)', () => {
  it('31 Mar 23:50 IST is still 2026-27; 1 Apr 00:10 IST starts 2027-28', () => {
    expect(financialYear('2027-03-31T18:20:00Z')).toBe('2026-27');
    expect(financialYear('2027-03-31T18:40:00Z')).toBe('2027-28');
  });

  it('turns over the century cleanly', () => {
    expect(financialYear('2099-06-01T00:00:00Z')).toBe('2099-00');
  });
});

describe('formatOrderNumber', () => {
  it('SO-YYMM-0001 with seq 142 in Nov 2026 → SO-2611-0142', () => {
    expect(formatOrderNumber('SO-YYMM-0001', '2026-11-06T05:00:00Z', 142)).toBe('SO-2611-0142');
  });

  it('YYMM comes from the IST date', () => {
    expect(formatOrderNumber('SO-YYMM-0001', '2026-10-31T19:00:00Z', 7)).toBe('SO-2611-0007');
  });

  it('grows past the padding instead of wrapping: seq 12345 → SO-2611-12345', () => {
    expect(formatOrderNumber('SO-YYMM-0001', '2026-11-06T05:00:00Z', 12_345)).toBe('SO-2611-12345');
  });

  it('pads to at least 4 digits even if the format shows fewer', () => {
    expect(formatOrderNumber('ORD-YYMM-1', '2026-11-06T05:00:00Z', 3)).toBe('ORD-2611-0003');
  });

  it('refuses a format with no number slot and a sequence below 1', () => {
    expect(() => formatOrderNumber('SO-YYMM', '2026-11-06T05:00:00Z', 1)).toThrow(RangeError);
    expect(() => formatOrderNumber('SO-YYMM-0001', '2026-11-06T05:00:00Z', 0)).toThrow(RangeError);
  });
});

describe('sub-order suffixes', () => {
  it('A…Z then AA, AB (spreadsheet style)', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(subOrderSuffix)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });

  it('property: every index gets a distinct suffix', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), fc.integer({ min: 0, max: 2000 }), (a, b) => {
        expect(subOrderSuffix(a) === subOrderSuffix(b)).toBe(a === b);
      }),
    );
  });

  it('SO-2611-0141 + A → SO-2611-0141-A', () => {
    expect(subOrderNumber('SO-2611-0141', 'A')).toBe('SO-2611-0141-A');
  });
});
