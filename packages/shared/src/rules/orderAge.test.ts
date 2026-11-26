import { describe, expect, it } from 'vitest';
import { orderAgeDays, agedCutoff, productsLabel } from './orderAge.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('orderAgeDays and agedCutoff', () => {
  it('an order is aged at (N+1) days, not a millisecond before; the cut-off is that instant', () => {
    const now = Date.UTC(2026, 10, 20);
    const n = 7;
    const cutoff = agedCutoff(now, n);
    expect(cutoff).toBe(now - (n + 1) * DAY);
    expect(orderAgeDays(cutoff, now) > n).toBe(true);
    expect(orderAgeDays(cutoff + 1, now) > n).toBe(false);
    expect(orderAgeDays(cutoff - 1, now) > n).toBe(true);
    expect(orderAgeDays(now + DAY, now)).toBe(0);
  });
});

describe('productsLabel', () => {
  it('merges mm sizes per category, in numeric order', () => {
    expect(
      productsLabel([
        { category: 'TMT', sizeLabel: '16 mm' },
        { category: 'TMT', sizeLabel: '8 mm' },
        { category: 'TMT', sizeLabel: '16 mm' },
        { category: 'Angle', sizeLabel: '50x50x5' },
      ]),
    ).toBe('TMT 8, 16 mm · Angle');
    expect(productsLabel([])).toBe('');
  });
});
