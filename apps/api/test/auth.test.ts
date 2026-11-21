import { createFakeClock } from '@tonnage/mock-api';
import { ERROR_MESSAGES, tokenPairSchema, type TokenPair } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OtpProvider } from '../src/auth/otp-provider.ts';
import { devices, otpChallenges, refreshTokens, users } from '../src/db/schema/index.ts';
import {
  TEST_NOW,
  buildTestApp,
  closeTestApps,
  ownerInsertTenant,
  ownerInsertUser,
  type TestApp,
} from './helpers.ts';

afterEach(closeTestApps);

const RAJESH = '+919826100012';
const DEVICE = '019a4c00-0000-7000-8000-00000000d001';

async function seed(t: TestApp) {
  await t.reset();
  const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  const userId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: RAJESH, name: 'Rajesh Agrawal' });
  return { tenantId, userId };
}

const post = (t: TestApp, path: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/v1/auth/${path}`, payload });

async function signIn(t: TestApp, mobile = RAJESH, code = '123456'): Promise<TokenPair> {
  expect((await post(t, 'request-code', { mobile })).statusCode).toBe(200);
  const res = await post(t, 'verify', { mobile, code, deviceId: DEVICE });
  expect(res.statusCode).toBe(200);
  return tokenPairSchema.parse(res.json());
}

function spyProvider() {
  const sent: { mobile: string; code: string }[] = [];
  const otp: OtpProvider = {
    async send(mobile, code) {
      sent.push({ mobile, code });
    },
  };
  return { otp, sent };
}

describe('auth: database behaviour', () => {
  let t: TestApp;
  let ids: { tenantId: string; userId: string };

  beforeEach(async () => {
    t = await buildTestApp();
    ids = await seed(t);
  });

  it('the code hash and refresh tokens are stored hashed, never in plaintext', async () => {
    const p1 = await signIn(t);
    const refreshed = await post(t, 'refresh', { refreshToken: p1.refreshToken, deviceId: DEVICE });
    expect(refreshed.statusCode).toBe(200);
    const p2 = tokenPairSchema.parse(refreshed.json());

    const otpRows = await t.ownerDb.select().from(otpChallenges);
    const tokenRows = await t.ownerDb.select().from(refreshTokens);
    expect(otpRows).toHaveLength(1);
    expect(tokenRows).toHaveLength(2);
    const dump = JSON.stringify([otpRows, tokenRows]);
    // The sealed successor is bytes; search those raw.
    const sealed = Buffer.concat(tokenRows.flatMap((r) => (r.successorEnc ? [r.successorEnc] : [])));
    expect(sealed.length).toBeGreaterThan(0);
    for (const secret of ['123456', p1.refreshToken, p2.refreshToken, p2.accessToken]) {
      expect(dump).not.toContain(secret);
      expect(sealed.includes(Buffer.from(secret))).toBe(false);
    }
    expect(otpRows[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // Keyed (HMAC), so a leaked row cannot be checked against the million possible codes.
    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    expect(otpRows[0]?.codeHash).not.toBe('123456');
    expect(otpRows[0]?.codeHash).not.toBe(sha('123456'));
    expect(otpRows[0]?.codeHash).not.toBe(sha(`${RAJESH}:123456`));
    for (const r of tokenRows) expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a failure is recorded even though the response is 401', async () => {
    await post(t, 'request-code', { mobile: RAJESH });
    const res = await post(t, 'verify', { mobile: RAJESH, code: '000000', deviceId: DEVICE });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'OTP_INVALID', message: ERROR_MESSAGES.OTP_INVALID });
    const [row] = await t.ownerDb.select().from(otpChallenges).where(eq(otpChallenges.mobile, RAJESH));
    expect(row?.failures).toBe(1);
    expect(row?.consumed).toBe(false);
  });

  it('a refresh reuse after the grace window commits its revocation even though the response is 401', async () => {
    const clock = createFakeClock(TEST_NOW);
    const t2 = await buildTestApp({ clock });
    await seed(t2);
    const p1 = await signIn(t2);
    await post(t2, 'refresh', { refreshToken: p1.refreshToken, deviceId: DEVICE });
    clock.advance(30_000);
    const reuse = await post(t2, 'refresh', { refreshToken: p1.refreshToken, deviceId: DEVICE });
    expect(reuse.statusCode).toBe(401);
    const rows = await t2.ownerDb.select().from(refreshTokens);
    expect(rows.every((r) => r.revokedAt?.getTime() === TEST_NOW + 30_000)).toBe(true);
    expect(rows.every((r) => r.successorEnc === null)).toBe(true);
  });

  it('verify upserts devices(deviceId) for the user; sign-out clears its push_token', async () => {
    const p1 = await signIn(t);
    let [device] = await t.ownerDb.select().from(devices);
    expect(device).toMatchObject({
      id: DEVICE,
      tenantId: ids.tenantId,
      userId: ids.userId,
      lastSeenAt: new Date(TEST_NOW),
    });
    const [user] = await t.ownerDb.select().from(users).where(eq(users.id, ids.userId));
    expect(user?.lastSeenAt).toEqual(new Date(TEST_NOW));

    // The same phone signs in as someone else in the tenant: the row moves to them.
    const priya = await ownerInsertUser(t.ownerDb, ids.tenantId, {
      mobile: '+919826100013',
      name: 'Priya Sharma',
      role: 'city_staff',
    });
    await t.ownerDb.update(devices).set({ pushToken: 'ExponentPushToken[abc]' });
    const p2 = await signIn(t, '+919826100013');
    const rows = await t.ownerDb.select().from(devices);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(priya);

    // Signing out with Rajesh's (now stale) session does not touch Priya's device.
    expect((await post(t, 'sign-out', { refreshToken: p1.refreshToken })).statusCode).toBe(204);
    [device] = await t.ownerDb.select().from(devices);
    expect(device?.pushToken).toBe('ExponentPushToken[abc]');

    const out = await post(t, 'sign-out', { refreshToken: p2.refreshToken });
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe('');
    [device] = await t.ownerDb.select().from(devices);
    expect(device?.pushToken).toBeNull();
    const revoked = await t.ownerDb.select().from(refreshTokens);
    expect(revoked.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('sign-out with an unknown token → 204', async () => {
    const res = await post(t, 'sign-out', { refreshToken: 'rt_nothing' });
    expect(res.statusCode).toBe(204);
  });

  it('request-code calls the provider only for an active user’s number', async () => {
    const spy = spyProvider();
    const t2 = await buildTestApp({ otp: spy.otp });
    const { tenantId } = await seed(t2);
    await ownerInsertUser(t2.ownerDb, tenantId, {
      mobile: '+919826100099',
      name: 'Gone',
      active: false,
    });
    for (const mobile of [RAJESH, '9999999999', '9826100099']) {
      const res = await post(t2, 'request-code', { mobile });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ resendAfterSeconds: 30 });
    }
    expect(spy.sent).toEqual([{ mobile: RAJESH, code: '123456' }]);
    // A challenge is recorded for every number, so resend and lockout behave the same.
    expect(await t2.ownerDb.select().from(otpChallenges)).toHaveLength(3);
  });

  it('no log line contains the code or a token', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    // A code no float or timestamp in a log line is likely to contain by chance.
    const code = '864209';
    const t2 = await buildTestApp({ env: { LOG_LEVEL: 'trace', DEV_OTP_CODE: code }, logStream });
    await seed(t2);
    const p1 = await signIn(t2, RAJESH, code);
    const res = await post(t2, 'refresh', { refreshToken: p1.refreshToken, deviceId: DEVICE });
    const p2 = tokenPairSchema.parse(res.json());
    await post(t2, 'sign-out', { refreshToken: p2.refreshToken });

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).toContain(RAJESH); // the dev provider logs the number it would text
    expect(all).not.toMatch(new RegExp(String.raw`(?<![\d.])${code}(?!\d)`));
    for (const secret of [p1.accessToken, p1.refreshToken, p2.accessToken, p2.refreshToken]) {
      expect(all).not.toContain(secret);
    }
  });
});
