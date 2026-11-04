import { expect, it } from 'vitest';
import { redactForRole } from './redact.ts';

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
