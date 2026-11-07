import { describe, expect, it } from 'vitest';
import { categoryTag, formatLength, productDisplayName } from './products.ts';

describe('productDisplayName', () => {
  it('TMT Fe500D · 12 mm and MS Billet · 100 × 100', () => {
    expect(productDisplayName({ category: 'TMT', grade: 'Fe500D', sizeLabel: '12 mm' })).toBe(
      'TMT Fe500D · 12 mm',
    );
    expect(productDisplayName({ category: 'MS Billet', grade: '', sizeLabel: '100 × 100' })).toBe(
      'MS Billet · 100 × 100',
    );
  });

  it('trims stray spaces so names stay consistent in lists and search', () => {
    expect(productDisplayName({ category: ' TMT ', grade: ' Fe500D', sizeLabel: '12 mm ' })).toBe(
      'TMT Fe500D · 12 mm',
    );
  });
});

describe('categoryTag', () => {
  it('first three letters of the last word, upper case', () => {
    expect(['TMT', 'MS Billet', 'MS Ingot', 'Angle', 'Channel'].map(categoryTag)).toEqual([
      'TMT',
      'BIL',
      'ING',
      'ANG',
      'CHA',
    ]);
  });
});

describe('formatLength', () => {
  it('12 m, 40 ft, 6 m', () => {
    expect(formatLength({ value: 12, unit: 'm' })).toBe('12 m');
    expect(formatLength({ value: 40, unit: 'ft' })).toBe('40 ft');
  });
});
