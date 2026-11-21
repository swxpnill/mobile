import type { ErrorCode, TokenPair } from '@tonnage/shared';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type Db, type Tx } from '../db/client.ts';
import { devices, otpChallenges, users } from '../db/schema/index.ts';
import type { Env } from '../env.ts';
import { AppError } from '../http/errors.ts';
import { createOtpHasher } from './crypto.ts';
import { newOtpCode, type OtpProvider } from './otp-provider.ts';
import type { Tokens } from './tokens.ts';

const MINUTE = 60_000;

/** Same values as the mock (`mock-api/src/handlers/auth.ts`). Every window is half-open. */
export const OTP_TTL_MS = 5 * MINUTE;
export const RESEND_AFTER_SECONDS = 30;
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * MINUTE;

export interface VerifyInput {
  mobile: string;
  code: string;
  deviceId: string;
  tenantId?: string | undefined;
}

export interface OtpService {
  /** Records a challenge for any number; texts a code only when an active user has it (Ruling 6). */
  requestCode(mobile: string, now: number): Promise<{ resendAfterSeconds: number }>;
  verify(input: VerifyInput, now: number): Promise<TokenPair>;
}

/** A refusal, returned from the transaction so its writes commit, then thrown (Ruling 5). */
class Refusal {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {}
  toError(): AppError {
    return new AppError(this.status, this.code, this.details);
  }
}

const otpInvalid = () => new Refusal(401, 'OTP_INVALID');
const otpLocked = () => new Refusal(429, 'OTP_LOCKED');

type Challenge = typeof otpChallenges.$inferSelect;

/** Locks the challenge row for this transaction; clears a lock that has run out (and its failures). */
async function lockChallenge(tx: Tx, mobile: string, now: number): Promise<Challenge | undefined> {
  const [rec] = await tx
    .select()
    .from(otpChallenges)
    .where(eq(otpChallenges.mobile, mobile))
    .for('update');
  if (rec?.lockedUntil && now >= rec.lockedUntil.getTime()) {
    const cleared = { lockedUntil: null, failures: 0, updatedAt: new Date(now) };
    await tx.update(otpChallenges).set(cleared).where(eq(otpChallenges.mobile, mobile));
    return { ...rec, ...cleared };
  }
  return rec;
}

interface LookupRow extends Record<string, unknown> {
  tenant_id: string;
  user_id: string;
  active: boolean;
  tenant_name: string;
}

/** Active users with this mobile across tenants (`auth_lookup_mobile`, before any tenant is set). */
async function activeAccounts(tx: Tx, mobile: string): Promise<LookupRow[]> {
  const res = await tx.execute<LookupRow>(
    sql`select tenant_id, user_id, active, tenant_name from auth_lookup_mobile(${mobile})`,
  );
  return res.rows.filter((r) => r.active);
}

export function createOtpService(deps: {
  db: Db;
  env: Pick<Env, 'OTP_PROVIDER' | 'DEV_OTP_CODE' | 'JWT_SECRET'>;
  otp: OtpProvider;
  tokens: Tokens;
}): OtpService {
  const { db, otp, tokens } = deps;
  const hasher = createOtpHasher(deps.env.JWT_SECRET);

  async function requestCode(mobile: string, now: number) {
    const outcome = await db.transaction(async (tx): Promise<Refusal | { code: string; send: boolean }> => {
      const at = new Date(now);
      // Identical for known and unknown numbers: a challenge row exists either way.
      await tx
        .insert(otpChallenges)
        .values({ mobile, createdAt: at, updatedAt: at })
        .onConflictDoNothing({ target: otpChallenges.mobile });
      const rec = await lockChallenge(tx, mobile, now);
      if (!rec) throw new Error('otp challenge row missing after upsert');
      if (rec.lockedUntil !== null) return otpLocked();
      if (rec.issuedAt !== null && now - rec.issuedAt.getTime() < RESEND_AFTER_SECONDS * 1000) {
        return new Refusal(429, 'OTP_RESEND_TOO_SOON');
      }
      const code = newOtpCode(deps.env);
      await tx
        .update(otpChallenges)
        .set({ codeHash: hasher.hashCode(mobile, code), issuedAt: at, consumed: false, updatedAt: at })
        .where(eq(otpChallenges.mobile, mobile));
      return { code, send: (await activeAccounts(tx, mobile)).length > 0 };
    });
    if (outcome instanceof Refusal) throw outcome.toError();
    // After the commit: the provider is never called while the row is locked.
    if (outcome.send) await otp.send(mobile, outcome.code);
    return { resendAfterSeconds: RESEND_AFTER_SECONDS };
  }

  async function verify(input: VerifyInput, now: number): Promise<TokenPair> {
    const outcome = await db.transaction(async (tx): Promise<Refusal | TokenPair> => {
      // The row lock serialises concurrent verifies, so no failure is lost (Review Focus 3).
      const rec = await lockChallenge(tx, input.mobile, now);
      if (!rec) return otpInvalid();
      if (rec.lockedUntil !== null) return otpLocked();
      if (rec.issuedAt === null || rec.consumed || rec.codeHash === null) return otpInvalid();
      if (now - rec.issuedAt.getTime() >= OTP_TTL_MS) return new Refusal(401, 'OTP_EXPIRED');

      const at = new Date(now);
      if (!hasher.codeMatches(rec.codeHash, input.mobile, input.code)) {
        const failures = rec.failures + 1;
        const lockedUntil = failures >= MAX_FAILURES ? new Date(now + LOCK_MS) : null;
        await tx
          .update(otpChallenges)
          .set({ failures, lockedUntil, updatedAt: at })
          .where(eq(otpChallenges.mobile, input.mobile));
        return lockedUntil ? otpLocked() : otpInvalid();
      }

      const accounts = await activeAccounts(tx, input.mobile);
      let account: LookupRow | undefined;
      if (input.tenantId !== undefined) {
        account = accounts.find((a) => a.tenant_id === input.tenantId);
      } else if (accounts.length > 1) {
        const choices = accounts
          .map((a) => ({ tenantId: a.tenant_id, tenantName: a.tenant_name }))
          .sort((a, b) => a.tenantName.localeCompare(b.tenantName));
        return new Refusal(409, 'TENANT_CHOICE_REQUIRED', choices);
      } else {
        account = accounts[0];
      }
      if (!account) return otpInvalid();
      const { tenant_id: tenantId, user_id: userId } = account;

      await tx
        .update(otpChallenges)
        .set({ consumed: true, failures: 0, updatedAt: at })
        .where(eq(otpChallenges.mobile, input.mobile));

      // Users and devices have RLS: written with the tenant set (ledger ruling P1).
      return withTenant(tx, tenantId, async (ttx) => {
        await ttx.update(users).set({ lastSeenAt: at }).where(eq(users.id, userId));
        // The phone moves to whoever signed in on it (Ruling 9).
        await ttx
          .insert(devices)
          .values({ id: input.deviceId, tenantId, userId, lastSeenAt: at, createdAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: [devices.tenantId, devices.id],
            set: { userId, lastSeenAt: at, updatedAt: at },
          });
        return tokens.issuePair(ttx, { id: userId, tenantId }, input.deviceId, now);
      });
    });
    if (outcome instanceof Refusal) throw outcome.toError();
    return outcome;
  }

  return { requestCode, verify };
}
