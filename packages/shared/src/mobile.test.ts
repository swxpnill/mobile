import { expect, it } from 'vitest';
import { normalizeIndianMobile } from './mobile.ts';

it('normalises valid numbers', () => {
  for (const s of ['+91 98260 12345', '9826012345', '09826012345', '919826012345', '+91-98260-12345'])
    expect(normalizeIndianMobile(s)).toBe('+919826012345');
});
it('rejects invalid numbers', () => {
  for (const s of ['12345', '5826012345', '98260123456', '', 'abc']) expect(normalizeIndianMobile(s)).toBeNull();
});
