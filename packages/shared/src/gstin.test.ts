import { describe, expect, it } from 'vitest';
import { checkGstin, gstinCheckChar, normalizeGstin } from './gstin.ts';

/** A GSTIN with a correct check character for the given first 14 characters. */
const valid = (first14: string) => first14 + gstinCheckChar(first14);

describe('checkGstin', () => {
  it('canvas Shubham Traders 27AAKFS1234L1Z5: valid format, Maharashtra', () => {
    const r = checkGstin('27AAKFS1234L1Z5');
    expect(r).toMatchObject({ ok: true, state: 'Maharashtra' });
  });

  it('a correct check character passes; changing it is flagged but still accepted (warning)', () => {
    const g = valid('22AEXPG5521K1Z');
    expect(checkGstin(g)).toEqual({ ok: true, state: 'Chhattisgarh', checksumOk: true });
    const wrong = g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A');
    expect(checkGstin(wrong)).toEqual({ ok: true, state: 'Chhattisgarh', checksumOk: false });
  });

  it('a published sample GSTIN checks out: 27AAPFU0939F1ZV', () => {
    expect(checkGstin('27AAPFU0939F1ZV')).toEqual({ ok: true, state: 'Maharashtra', checksumOk: true });
  });

  it('wrong shape → format; unknown state code → state', () => {
    expect(checkGstin('27AAKFS1234L1Z')).toEqual({ ok: false, reason: 'format' });
    expect(checkGstin('27AAKFS1234L1X5')).toEqual({ ok: false, reason: 'format' });
    expect(checkGstin('99AAKFS1234L1Z5')).toEqual({ ok: false, reason: 'state' });
    expect(checkGstin('00AAKFS1234L1Z5')).toEqual({ ok: false, reason: 'state' });
  });

  it('typed in lower case with spaces → normalised first', () => {
    expect(normalizeGstin(' 27aakfs1234l1z5 ')).toBe('27AAKFS1234L1Z5');
    expect(checkGstin(' 27aakfs 1234l1z5')).toMatchObject({ ok: true, state: 'Maharashtra' });
  });

  it('97 (Other Territory) and 38 (Ladakh) are valid state codes', () => {
    expect(checkGstin(valid('97AAKFS1234L1Z'))).toMatchObject({ ok: true, state: 'Other Territory' });
    expect(checkGstin(valid('38AAKFS1234L1Z'))).toMatchObject({ ok: true, state: 'Ladakh' });
  });
});
