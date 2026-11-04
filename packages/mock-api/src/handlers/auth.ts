import {
  refreshBodySchema,
  requestCodeBodySchema,
  signOutBodySchema,
  verifyCodeBodySchema,
} from '@tonnage/shared';
import { MINUTE, SECOND, fromIso, toIso } from '../clock.ts';
import { ApiError, unauthenticated } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import { REFRESH_GRACE_MS, issueTokens, pruneTokens, revokeAllForUser } from '../sessions.ts';
import type { MockState, OtpRec } from '../store.ts';

export const DEV_OTP_CODE = '123456';
export const RESEND_AFTER_SECONDS = 30;
const OTP_TTL_MS = 5 * MINUTE;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * MINUTE;

/** OTP record for a mobile, clearing an expired lock. */
function otpFor(state: MockState, mobile: string, now: number): OtpRec {
  const rec = (state.otp[mobile] ??= {
    issuedAt: null,
    consumed: false,
    failures: 0,
    lockedUntil: null,
  });
  if (rec.lockedUntil !== null && now >= fromIso(rec.lockedUntil)) {
    rec.lockedUntil = null;
    rec.failures = 0;
  }
  return rec;
}

const locked = () => new ApiError(429, 'OTP_LOCKED');
const otpInvalid = () => new ApiError(401, 'OTP_INVALID');

export const authRoutes: RouteDef[] = [
  route('POST', '/v1/auth/request-code', {
    public: true,
    body: requestCodeBodySchema,
    async handler({ body, state, now }) {
      // Identical for known and unknown numbers: a challenge is recorded either way.
      const otp = otpFor(state, body.mobile, now);
      if (otp.lockedUntil !== null) throw locked();
      if (otp.issuedAt !== null && now - fromIso(otp.issuedAt) < RESEND_AFTER_SECONDS * SECOND) {
        throw new ApiError(429, 'OTP_RESEND_TOO_SOON');
      }
      otp.issuedAt = toIso(now);
      otp.consumed = false;
      return { body: { resendAfterSeconds: RESEND_AFTER_SECONDS } };
    },
  }),

  route('POST', '/v1/auth/verify', {
    public: true,
    body: verifyCodeBodySchema,
    async handler({ body, state, now }) {
      const otp = otpFor(state, body.mobile, now);
      if (otp.lockedUntil !== null) throw locked();
      if (otp.issuedAt === null || otp.consumed) throw otpInvalid();
      if (now - fromIso(otp.issuedAt) >= OTP_TTL_MS) throw new ApiError(401, 'OTP_EXPIRED');
      if (body.code !== DEV_OTP_CODE) {
        otp.failures += 1;
        if (otp.failures >= MAX_FAILURES) {
          otp.lockedUntil = toIso(now + LOCK_MS);
          throw locked();
        }
        throw otpInvalid();
      }

      const matches = state.users.filter((u) => u.mobile === body.mobile && u.active);
      if (matches.length === 0) throw otpInvalid();
      let user = matches[0];
      if (body.tenantId !== undefined) {
        user = matches.find((u) => u.tenantId === body.tenantId);
        if (!user) throw otpInvalid();
      } else if (matches.length > 1) {
        const details = matches
          .map((u) => ({
            tenantId: u.tenantId,
            tenantName: state.tenants.find((t) => t.id === u.tenantId)?.name ?? '',
          }))
          .sort((a, b) => a.tenantName.localeCompare(b.tenantName));
        throw new ApiError(409, 'TENANT_CHOICE_REQUIRED', details);
      }
      if (!user) throw otpInvalid();

      otp.consumed = true;
      otp.failures = 0;
      user.lastSeenAt = toIso(now);
      pruneTokens(state, now);
      return { body: issueTokens(state, user.id, body.deviceId, now) };
    },
  }),

  route('POST', '/v1/auth/refresh', {
    public: true,
    body: refreshBodySchema,
    async handler({ body, state, now }) {
      const rec = state.refreshTokens[body.refreshToken];
      if (!rec || rec.deviceId !== body.deviceId) throw unauthenticated();
      const user = state.users.find((u) => u.id === rec.userId);
      if (!user || !user.active) throw unauthenticated();
      if (rec.rotatedAt !== null) {
        const successor = rec.successor;
        const successorLive =
          successor !== null && state.refreshTokens[successor.refreshToken]?.revokedAt === null;
        if (now - fromIso(rec.rotatedAt) < REFRESH_GRACE_MS && successorLive) {
          return { body: successor }; // identical retry within the grace window
        }
        revokeAllForUser(state, rec.userId, now); // reuse after grace: treat as theft
        throw unauthenticated();
      }
      if (rec.revokedAt !== null || now >= fromIso(rec.expiresAt)) throw unauthenticated();

      const pair = issueTokens(state, rec.userId, rec.deviceId, now);
      rec.rotatedAt = toIso(now);
      rec.successor = pair;
      pruneTokens(state, now);
      return { body: pair };
    },
  }),

  route('POST', '/v1/auth/sign-out', {
    public: true,
    body: signOutBodySchema,
    async handler({ body, state, now }) {
      const rec = state.refreshTokens[body.refreshToken];
      if (rec && rec.revokedAt === null) rec.revokedAt = toIso(now);
      return { status: 204 };
    },
  }),
];
