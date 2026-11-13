import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseRateInput, toDisplayRate } from '../units.ts';
import { billedRate, brokerEarningEstimate, lineRate, lineValue, roundHalfUp } from './money.ts';

describe('roundHalfUp', () => {
  it('half-up: 1 kg × ₹500 = ₹0.5 → ₹1; 1 kg × ₹499 → ₹0', () => {
    expect(roundHalfUp(500, 1000)).toBe(1);
    expect(roundHalfUp(499, 1000)).toBe(0);
    expect(roundHalfUp(1500, 1000)).toBe(2);
    expect(roundHalfUp(0, 1000)).toBe(0);
  });

  it('refuses negative, fractional or zero-denominator input instead of guessing', () => {
    expect(() => roundHalfUp(-1, 1000)).toThrow(RangeError);
    expect(() => roundHalfUp(1.5, 1000)).toThrow(RangeError);
    expect(() => roundHalfUp(1, 0)).toThrow(RangeError);
  });

  it('property: matches exact half-up rounding for the largest allowed line', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (kg, rate) => {
          const n = kg * rate;
          const expected = Number((BigInt(n) * 2n + 1000n) / 2000n);
          expect(roundHalfUp(n, 1000)).toBe(expected);
        },
      ),
    );
  });
});

describe('lineRate', () => {
  it('basic + conversion: ₹44,500 + ₹1,500 = ₹46,000, not edited; typed ₹46,300 is edited', () => {
    expect(
      lineRate({ method: 'basic_conversion', basicRate: 44_500, conversionPerMt: 1_500, typedRate: null }),
    ).toEqual({ rate: 46_000, rateEdited: false });
    expect(
      lineRate({ method: 'basic_conversion', basicRate: 44_500, conversionPerMt: 1_500, typedRate: 46_300 }),
    ).toEqual({ rate: 46_300, rateEdited: true });
  });

  it('typing the same rate the formula gives is not an override', () => {
    expect(
      lineRate({ method: 'basic_conversion', basicRate: 44_500, conversionPerMt: 1_500, typedRate: 46_000 }),
    ).toEqual({ rate: 46_000, rateEdited: false });
  });

  it('direct: the typed rate is the rate and is never "edited"', () => {
    expect(
      lineRate({ method: 'direct', basicRate: null, conversionPerMt: 1_500, typedRate: 45_600 }),
    ).toEqual({ rate: 45_600, rateEdited: false });
  });

  it('missing inputs are programming errors (the schemas guarantee them)', () => {
    expect(() =>
      lineRate({ method: 'direct', basicRate: null, conversionPerMt: 0, typedRate: null }),
    ).toThrow(RangeError);
    expect(() =>
      lineRate({ method: 'basic_conversion', basicRate: null, conversionPerMt: 0, typedRate: null }),
    ).toThrow(RangeError);
  });
});

describe('line value', () => {
  it('canvas line: 24.000 MT × ₹46,000 + ₹300 overprice = ₹11,11,200', () => {
    expect(lineValue(24_000, billedRate(46_000, 300))).toBe(1_111_200);
  });

  it('canvas order: four lines sum to ₹38,64,200', () => {
    const total =
      lineValue(24_000, billedRate(46_000, 300)) +
      lineValue(10_000, billedRate(46_000, 0)) +
      lineValue(20_000, billedRate(45_500, 300)) +
      lineValue(30_000, billedRate(45_600, 300));
    expect(total).toBe(3_864_200);
  });

  it('property: line value is identical whether the rate was typed as ₹/MT or ₹/kg', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (kg, ratePerMt) => {
          const typedAsKg = toDisplayRate(ratePerMt, 'kg').replace('₹', '');
          const parsed = parseRateInput(typedAsKg, 'kg');
          expect(parsed).toEqual({ ok: true, value: ratePerMt });
          if (parsed.ok) expect(lineValue(kg, parsed.value)).toBe(lineValue(kg, ratePerMt));
        },
      ),
    );
  });
});

describe('brokerEarningEstimate', () => {
  it('canvas review estimate: 84 MT × ₹150 = ₹12,600; 74 MT × ₹300 = ₹22,200; total ₹34,800', () => {
    const lines = [
      { orderedKg: 24_000, overpricePerMt: 300 },
      { orderedKg: 10_000, overpricePerMt: 0 },
      { orderedKg: 20_000, overpricePerMt: 300 },
      { orderedKg: 30_000, overpricePerMt: 300 },
    ];
    expect(brokerEarningEstimate(lines, 150)).toEqual({
      commission: 12_600,
      overprice: 22_200,
      total: 34_800,
      commissionKg: 84_000,
      overpriceKg: 74_000,
    });
  });

  it('spec check: 24.180 MT × (₹150 + ₹300) = ₹10,881', () => {
    expect(brokerEarningEstimate([{ orderedKg: 24_180, overpricePerMt: 300 }], 150).total).toBe(
      10_881,
    );
  });

  it('overprice is rounded once over all lines, not per line', () => {
    // 1 kg × ₹500 three times: per line 0.5 → 1 each = 3; once over the total 1.5 → 2.
    const lines = [1, 1, 1].map((kg) => ({ orderedKg: kg, overpricePerMt: 500 }));
    expect(brokerEarningEstimate(lines, 0).overprice).toBe(2);
  });

  it('no lines → all zero', () => {
    expect(brokerEarningEstimate([], 150)).toEqual({
      commission: 0,
      overprice: 0,
      total: 0,
      commissionKg: 0,
      overpriceKg: 0,
    });
  });
});
