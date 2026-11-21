import { ERROR_MESSAGES, tokenPairSchema } from '@tonnage/shared';
import { createFakeClock } from '@tonnage/mock-api';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { otpChallenges, refreshTokens } from '../src/db/schema/index.ts';
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
const DEVICE_B = '019a4c00-0000-7000-8000-00000000d002';

let t: TestApp;
let clock: ReturnType<typeof createFakeClock>;

beforeEach(async () => {
  // A real pool (default size 10), requests in flight together: the database decides the order.
  clock = createFakeClock(TEST_NOW);
  t = await buildTestApp({ clock });
  await t.reset();
  const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  await ownerInsertUser(t.ownerDb, tenantId, { mobile: RAJESH, name: 'Rajesh Agrawal' });
});

const post = (path: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/v1/auth/${path}`, payload });

/** How many of the API's transactions are waiting on a lock. Polled on its own connection: inside
 * the holder's transaction pg_stat_activity would be a snapshot. */
async function waitForLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await t.ownerDb.$client.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where usename = 'tonnage_app' and wait_event_type = 'Lock'`,
    );
    const waiting = res.rows[0]?.n ?? 0;
    if (waiting >= count) return;
    if (attempt > 2000) throw new Error(`only ${waiting} of ${count} requests reached a lock`);
  }
}

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
      await waitForLockWaiters(inFlight.length);
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
});
