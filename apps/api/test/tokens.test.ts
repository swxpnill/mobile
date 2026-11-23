import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { ACCESS_TTL_MS, createTokens } from '../src/auth/tokens.ts';
import { createOtpHasher, createSuccessorBox } from '../src/auth/crypto.ts';
import { TEST_NOW } from './helpers.ts';

const SECRET = 'test-secret-test-secret-test-secret-0123';
const USER = { id: '019a4c00-0000-7000-8000-0000000000a1', tenantId: '019a4c00-0000-7000-8000-0000000000b1' };
const DEVICE = '019a4c00-0000-7000-8000-00000000d001';
const tokens = createTokens(SECRET);

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('access tokens (fake clock)', () => {
  it('access token is valid at 15 min − 1 ms and rejected at 15 min', async () => {
    const { token, expiresAt } = await tokens.issueAccess(USER, DEVICE, TEST_NOW);
    expect(expiresAt).toBe(new Date(TEST_NOW + ACCESS_TTL_MS).toISOString());
    expect(await tokens.verifyAccess(token, TEST_NOW + ACCESS_TTL_MS - 1)).toEqual({
      userId: USER.id,
      tenantId: USER.tenantId,
      deviceId: DEVICE,
    });
    expect(await tokens.verifyAccess(token, TEST_NOW + ACCESS_TTL_MS)).toBeNull();
  });

  it('never outlives the expiry it reports, when issued between whole seconds', async () => {
    const now = TEST_NOW + 750;
    const { token, expiresAt } = await tokens.issueAccess(USER, DEVICE, now);
    const reported = Date.parse(expiresAt);
    expect(reported).toBeLessThanOrEqual(now + ACCESS_TTL_MS);
    expect(await tokens.verifyAccess(token, reported - 1)).not.toBeNull();
    expect(await tokens.verifyAccess(token, reported)).toBeNull();
  });

  it('carries sub, tid, did, iat and exp', async () => {
    const { token } = await tokens.issueAccess(USER, DEVICE, TEST_NOW);
    const [header, payload] = token.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({ alg: 'HS256' });
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toEqual({
      sub: USER.id,
      tid: USER.tenantId,
      did: DEVICE,
      iat: TEST_NOW / 1000,
      exp: (TEST_NOW + ACCESS_TTL_MS) / 1000,
    });
  });

  it('a token signed with another secret, alg none, or tampered payload → null', async () => {
    const now = TEST_NOW + 1000;
    const other = await createTokens('another-secret-another-secret-another-1').issueAccess(USER, DEVICE, TEST_NOW);
    expect(await tokens.verifyAccess(other.token, now)).toBeNull();

    const claims = { sub: USER.id, tid: USER.tenantId, did: DEVICE, iat: TEST_NOW / 1000, exp: TEST_NOW / 1000 + 900 };
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    expect(await tokens.verifyAccess(none, now)).toBeNull();

    const hs512 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS512' })
      .sign(new TextEncoder().encode(SECRET.repeat(2)));
    expect(await tokens.verifyAccess(hs512, now)).toBeNull();

    const { token } = await tokens.issueAccess(USER, DEVICE, TEST_NOW);
    const [h, , sig] = token.split('.');
    const tampered = `${h}.${b64({ ...claims, tid: '019a4c00-0000-7000-8000-0000000000b2' })}.${sig}`;
    expect(await tokens.verifyAccess(tampered, now)).toBeNull();

    expect(await tokens.verifyAccess('not-a-jwt', now)).toBeNull();
  });

  it('a validly signed token missing a claim → null', async () => {
    const partial = await new SignJWT({ sub: USER.id, tid: USER.tenantId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(TEST_NOW / 1000)
      .setExpirationTime(TEST_NOW / 1000 + 900)
      .sign(new TextEncoder().encode(SECRET));
    expect(await tokens.verifyAccess(partial, TEST_NOW + 1000)).toBeNull();
  });
});

describe('sealed successor pair', () => {
  const pair = { accessToken: 'a.b.c', refreshToken: 'rt_xyz', accessExpiresAt: '2026-11-03T04:45:00.000Z' };

  it('round-trips, with a fresh IV each time, and refuses another key or a flipped bit', () => {
    const box = createSuccessorBox(SECRET);
    const a = box.sealSuccessor(pair);
    const b = box.sealSuccessor(pair);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('rt_xyz'))).toBe(false);
    expect(box.openSuccessor(a)).toEqual(pair);

    expect(() => createSuccessorBox('another-secret-another-secret-another-1').openSuccessor(a)).toThrow();
    const flipped = Buffer.from(a);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => box.openSuccessor(flipped)).toThrow();
  });
});

describe('OTP code hash', () => {
  it('is an HMAC bound to the number and the key, checked in constant time', () => {
    const hasher = createOtpHasher(SECRET);
    const h = hasher.hashCode('+919826100012', '123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hasher.codeMatches(h, '+919826100012', '123456')).toBe(true);
    expect(hasher.codeMatches(h, '+919826100012', '123457')).toBe(false);
    expect(hasher.codeMatches(h, '+919826100013', '123456')).toBe(false);
    expect(createOtpHasher('another-secret-another-secret-another-1').hashCode('+919826100012', '123456')).not.toBe(h);
    expect(hasher.codeMatches('not-hex', '+919826100012', '123456')).toBe(false);
  });
});
