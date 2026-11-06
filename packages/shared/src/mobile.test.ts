import { describe, expect, it } from 'vitest';
import { formatMobile, normalizeIndianMobile } from './mobile.ts';

it('normalises valid numbers', () => {
  for (const s of [
    '+91 98260 12345',
    '9826012345',
    '09826012345',
    '919826012345',
    '+91-98260-12345',
  ])
    expect(normalizeIndianMobile(s)).toBe('+919826012345');
});
it('rejects invalid numbers', () => {
  for (const s of ['12345', '5826012345', '98260123456', '', 'abc'])
    expect(normalizeIndianMobile(s)).toBeNull();
});

describe('formatMobile', () => {
  it('shows a stored number the way the canvas does', () => {
    expect(formatMobile('+919826100012')).toBe('+91 98261 00012');
  });
  it('leaves anything that is not a normalised Indian mobile unchanged', () => {
    expect(formatMobile('12345')).toBe('12345');
  });
});
