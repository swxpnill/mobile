import { describe, expect, it } from 'vitest';
import { formatRupees, formatRupeesShort } from './format.ts';

describe('formatRupees', () => {
  it('formats with Indian grouping', () => {
    expect(formatRupees(146000)).toBe('₹1,46,000');
    expect(formatRupees(3864200)).toBe('₹38,64,200');
    expect(formatRupees(-40000)).toBe('−₹40,000');
    expect(formatRupees(0)).toBe('₹0');
  });
});

describe('formatRupeesShort', () => {
  it('abbreviates lakh and crore', () => {
    expect(formatRupeesShort(5580000)).toBe('₹55.80 L');
    expect(formatRupeesShort(14600000)).toBe('₹1.46 Cr');
    expect(formatRupeesShort(86400)).toBe('₹86,400');
    expect(formatRupeesShort(482000)).toBe('₹4.82 L');
  });
  it('rounds half up at 2 decimals and handles negatives', () => {
    expect(formatRupeesShort(100500)).toBe('₹1.01 L');
    expect(formatRupeesShort(-482000)).toBe('−₹4.82 L');
  });
});
