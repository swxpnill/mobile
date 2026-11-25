import { ERROR_MESSAGES, tokenPairSchema } from '@tonnage/shared';
import { createFakeClock } from '@tonnage/mock-api';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { otpChallenges, refreshTokens } from '../src/db/schema/index.ts';
import {
  TEST_NOW,
  bearerFor,
  buildTestApp,
  closeTestApps,
  ownerInsertTenant,
  ownerInsertUser,
  type TestApp,
} from './helpers.ts';
import { waitForLockWaiters } from './support/lockWait.ts';

afterEach(closeTestApps);

const RAJESH = '+919826100012';
const DEVICE = '019a4c00-0000-7000-8000-00000000d001';
const DEVICE_B = '019a4c00-0000-7000-8000-00000000d002';

let t: TestApp;
let clock: ReturnType<typeof createFakeClock>;
let tenantId: string;
let ownerId: string;

beforeEach(async () => {
  // A real pool (default size 10), requests in flight together: the database decides the order.
  clock = createFakeClock(TEST_NOW);
  t = await buildTestApp({ clock });
  await t.reset();
  tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  ownerId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: RAJESH, name: 'Rajesh Agrawal' });
});

const post = (path: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/v1/auth/${path}`, payload });

/**
 * Makes the race deterministic: the test holds a row lock (owner connection) and sends the requests
 * in stages, waiting after each stage until all requests sent so far are blocked on a lock; then it
 * lets go. Every request is in flight, in the stated order, whatever the pool or the scheduler does.
 */
async function raceBehindRowLock<T>(
  lockSql: string,
  params: unknown[],
  ...stages: (() => Promise<T>[])[]
): Promise<T[]> {
  const holder = await t.ownerDb.$client.connect();
  try {
    await holder.query('begin');
    const locked = await holder.query(lockSql, params);
    expect(locked.rowCount).toBe(1);
    const inFlight: Promise<T>[] = [];
    for (const stage of stages) {
      inFlight.push(...stage());
      await waitForLockWaiters(t.ownerDb, inFlight.length);
    }
    await holder.query('commit');
    return await Promise.all(inFlight);
  } finally {
    holder.release();
  }
}

describe('auth under concurrency', () => {
  it('Review Focus 1: two concurrent refreshes of one token → both 200 with the identical pair; no tokens revoked', async () => {
    await post('request-code', { mobile: RAJESH });
    const p1 = tokenPairSchema.parse(
      (await post('verify', { mobile: RAJESH, code: '123456', deviceId: DEVICE })).json(),
    );

    const [a, b] = await raceBehindRowLock(
      'select 1 from refresh_tokens where user_id = (select id from users where mobile = $1) for update',
      [RAJESH],
      () => [
        post('refresh', { refreshToken: p1.refreshToken, deviceId: DEVICE }),
        post('refresh', { refreshToken: p1.refreshToken, deviceId: DEVICE }),
      ],
    );
    if (!a || !b) throw new Error('two responses expected');
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    expect(tokenPairSchema.parse(a.json()).refreshToken).not.toBe(p1.refreshToken);

    expect(await t.ownerDb.select().from(refreshTokens).where(isNotNull(refreshTokens.revokedAt))).toEqual([]);
    expect(await t.ownerDb.select().from(refreshTokens)).toHaveLength(2); // one rotation, not two
  });

  it('Review Focus 3: five wrong codes in parallel → locked; 123456 then 429 OTP_LOCKED', async () => {
    await post('request-code', { mobile: RAJESH });
    const wrong = await raceBehindRowLock(
      'select 1 from otp_challenges where mobile = $1 for update',
      [RAJESH],
      () => Array.from({ length: 5 }, () => post('verify', { mobile: RAJESH, code: '000000', deviceId: DEVICE })),
    );
    const codes = wrong.map((r) => `${r.statusCode} ${r.json<{ code: string }>().code}`).sort();
    expect(codes).toEqual([
      '401 OTP_INVALID',
      '401 OTP_INVALID',
      '401 OTP_INVALID',
      '401 OTP_INVALID',
      '429 OTP_LOCKED',
    ]);
    const [row] = await t.ownerDb.select().from(otpChallenges).where(eq(otpChallenges.mobile, RAJESH));
    expect(row?.failures).toBe(5);
    expect(row?.lockedUntil).not.toBeNull();

    const right = await post('verify', { mobile: RAJESH, code: '123456', deviceId: DEVICE });
    expect(right.statusCode).toBe(429);
    expect(right.json()).toEqual({ code: 'OTP_LOCKED', message: ERROR_MESSAGES.OTP_LOCKED });
  });

  it('revoke-all cannot miss a token another device is rotating at that moment', async () => {
    const signInOn = async (deviceId: string) => {
      expect((await post('request-code', { mobile: RAJESH })).statusCode).toBe(200);
      const res = await post('verify', { mobile: RAJESH, code: '123456', deviceId });
      return tokenPairSchema.parse(res.json());
    };
    const phone = await signInOn(DEVICE);
    expect((await post('refresh', { refreshToken: phone.refreshToken, deviceId: DEVICE })).statusCode).toBe(200);
    clock.advance(30_000);
    const tablet = await signInOn(DEVICE_B);
    clock.advance(1_000); // the phone's old token is now past its grace window

    // Stage 1: the tablet's rotation starts first and is held on the user row. (Without the user
    // lock it would get further: its new token inserted but uncommitted, its old row locked, blocked
    // in the foreign-key check.) Stage 2: the stolen phone token is replayed, triggering revoke-all.
    const [rotation, reuse] = await raceBehindRowLock(
      'select 1 from users where mobile = $1 for update',
      [RAJESH],
      () => [post('refresh', { refreshToken: tablet.refreshToken, deviceId: DEVICE_B })],
      () => [post('refresh', { refreshToken: phone.refreshToken, deviceId: DEVICE })],
    );
    expect(reuse?.statusCode).toBe(401);
    expect([200, 401]).toContain(rotation?.statusCode);
    // Whichever ran first, theft detection leaves this person no live refresh token.
    expect(await t.ownerDb.select().from(refreshTokens).where(isNull(refreshTokens.revokedAt))).toEqual([]);
  });

  it('a sign-in racing a deactivation that commits first → 401 OTP_INVALID and no live refresh token', async () => {
    const PRIYA = '+919826100013';
    const priyaId = await ownerInsertUser(t.ownerDb, tenantId, {
      mobile: PRIYA,
      name: 'Priya Sharma',
      role: 'city_staff',
    });
    expect((await post('request-code', { mobile: PRIYA })).statusCode).toBe(200);
    const owner = await bearerFor(t, tenantId, ownerId);

    // Stage 1: the owner's deactivation queues on Priya's row first. Stage 2: her verify has already
    // read her as active (no lock yet) and queues behind it on the same row. The deactivation commits
    // first; the verify must notice, not issue a token to someone no longer active.
    const [deactivate, verify] = await raceBehindRowLock(
      'select 1 from users where id = $1 for update',
      [priyaId],
      () => [t.app.inject({ method: 'POST', url: `/v1/users/${priyaId}/deactivate`, headers: owner })],
      () => [post('verify', { mobile: PRIYA, code: '123456', deviceId: DEVICE })],
    );
    expect(deactivate?.statusCode).toBe(200);
    expect(verify?.statusCode).toBe(401);
    expect(verify?.json()).toEqual({ code: 'OTP_INVALID', message: ERROR_MESSAGES.OTP_INVALID });
    expect(
      await t.ownerDb
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, priyaId), isNull(refreshTokens.revokedAt))),
    ).toEqual([]);
  });
});
