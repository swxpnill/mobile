import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  parseQtyInput,
  parseRateInput,
  toDisplayQty,
  toDisplayRate,
  unitLabel,
  type UnitBasis,
} from './units.ts';

describe('toDisplayQty', () => {
  it('mt: 3 decimals with Indian grouping', () => {
    expect(toDisplayQty(24180, 'mt')).toBe('24.180');
    expect(toDisplayQty(1248640, 'mt', { withUnit: true })).toBe('1,248.640 MT');
    expect(toDisplayQty(0, 'mt')).toBe('0.000');
  });
  it('kg: whole number with Indian grouping', () => {
    expect(toDisplayQty(24180, 'kg')).toBe('24,180');
    expect(toDisplayQty(1248640, 'kg', { withUnit: true })).toBe('12,48,640 kg');
  });
});

describe('unitLabel', () => {
  it('maps basis to label', () => {
    expect(unitLabel('mt')).toBe('MT');
    expect(unitLabel('kg')).toBe('kg');
  });
});

describe('parseQtyInput', () => {
  it('mt', () => {
    expect(parseQtyInput('24.18', 'mt')).toEqual({ ok: true, value: 24180 });
    expect(parseQtyInput(' 1,248.640 ', 'mt')).toEqual({ ok: true, value: 1248640 });
    expect(parseQtyInput('.5', 'mt')).toEqual({ ok: true, value: 500 });
    expect(parseQtyInput('24.1805', 'mt')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
    expect(parseQtyInput('', 'mt')).toEqual({ ok: false, error: 'EMPTY' });
    expect(parseQtyInput('-2', 'mt')).toEqual({ ok: false, error: 'INVALID' });
    expect(parseQtyInput('2.4.1', 'mt')).toEqual({ ok: false, error: 'INVALID' });
  });
  it('kg', () => {
    expect(parseQtyInput('24,180', 'kg')).toEqual({ ok: true, value: 24180 });
    expect(parseQtyInput('24180.5', 'kg')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
  });
});

describe('rates', () => {
  it('display', () => {
    expect(toDisplayRate(46300, 'mt', { withUnit: true })).toBe('₹46,300 / MT');
    expect(toDisplayRate(46300, 'kg', { withUnit: true })).toBe('₹46.300 / kg');
    expect(toDisplayRate(150, 'kg')).toBe('₹0.150');
  });
  it('parse', () => {
    expect(parseRateInput('46,300', 'mt')).toEqual({ ok: true, value: 46300 });
    expect(parseRateInput('46300.5', 'mt')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
    expect(parseRateInput('46.3', 'kg')).toEqual({ ok: true, value: 46300 });
    expect(parseRateInput('0.45', 'kg')).toEqual({ ok: true, value: 450 });
    expect(parseRateInput('46.3051', 'kg')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
  });
  it('round-trips losslessly', () => {
    for (const kg of [0, 1, 999, 1000, 24180, 1248640]) {
      for (const b of ['mt', 'kg'] as const) {
        expect(parseQtyInput(toDisplayQty(kg, b), b)).toEqual({ ok: true, value: kg });
      }
    }
    for (const r of [0, 1, 150, 46300, 4630000]) {
      for (const b of ['mt', 'kg'] as const) {
        expect(parseRateInput(toDisplayRate(r, b).replace('₹', ''), b)).toEqual({
          ok: true,
          value: r,
        });
      }
    }
  });
});

describe('properties', () => {
  const basis = fc.constantFrom<UnitBasis>('mt', 'kg');
  it('parse(display(kg)) === kg for any integer kg in [0, 10^10]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), basis, (kg, b) => {
        expect(parseQtyInput(toDisplayQty(kg, b), b)).toEqual({ ok: true, value: kg });
      }),
    );
  });
  it('parseRate(displayRate(r)) === r for any integer rate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), basis, (r, b) => {
        expect(parseRateInput(toDisplayRate(r, b).replace('₹', ''), b)).toEqual({
          ok: true,
          value: r,
        });
      }),
    );
  });
});
