import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { assignable, over, pending, totalsOf, type LineQty } from './quantities.ts';

const line = (o: Partial<LineQty>): LineQty => ({
  orderedKg: 0,
  dispatchedKg: 0,
  closedKg: 0,
  reservedKg: 0,
  ...o,
});
const kg = fc.integer({ min: 0, max: 10_000_000 });

describe('line quantities', () => {
  it('pending = ordered − dispatched − closed', () => {
    expect(pending(line({ orderedKg: 40_000, dispatchedKg: 28_400 }))).toBe(11_600);
    expect(pending(line({ orderedKg: 42_000, dispatchedKg: 30_200, closedKg: 11_800 }))).toBe(0);
  });

  it('over-dispatch: 48,000 ordered / 48,240 dispatched → pending 0, over 240', () => {
    const l = line({ orderedKg: 48_000, dispatchedKg: 48_240 });
    expect(pending(l)).toBe(0);
    expect(over(l)).toBe(240);
  });

  it('assignable = pending − reserved, and may go negative (a warning, never a block)', () => {
    expect(assignable(line({ orderedKg: 30_000, reservedKg: 12_000 }))).toBe(18_000);
    expect(assignable(line({ orderedKg: 30_000, reservedKg: 35_000 }))).toBe(-5_000);
  });

  it('property: pending and over are never negative and never both positive', () => {
    fc.assert(
      fc.property(kg, kg, kg, (orderedKg, dispatchedKg, closedKg) => {
        const l = line({ orderedKg, dispatchedKg, closedKg });
        expect(pending(l)).toBeGreaterThanOrEqual(0);
        expect(over(l)).toBeGreaterThanOrEqual(0);
        expect(pending(l) > 0 && over(l) > 0).toBe(false);
      }),
    );
  });
});

describe('totalsOf', () => {
  it("sums per line and never nets one line's over against another line's pending", () => {
    const t = totalsOf([
      line({ orderedKg: 10_000, dispatchedKg: 12_000 }),
      line({ orderedKg: 10_000, dispatchedKg: 4_000, reservedKg: 3_000 }),
    ]);
    expect(t).toEqual({
      orderedKg: 20_000,
      dispatchedKg: 16_000,
      closedKg: 0,
      reservedKg: 3_000,
      pendingKg: 6_000,
      overKg: 2_000,
    });
  });

  it('empty → zeros', () => {
    expect(totalsOf([])).toEqual({
      orderedKg: 0,
      dispatchedKg: 0,
      closedKg: 0,
      reservedKg: 0,
      pendingKg: 0,
      overKg: 0,
    });
  });
});
