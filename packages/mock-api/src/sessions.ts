import type { TokenPair } from '@tonnage/shared';
import { v7 } from 'uuid';
import { DAY, MINUTE, fromIso, toIso } from './clock.ts';
import type { MockState, UserRec } from './store.ts';

export const ACCESS_TTL_MS = 15 * MINUTE;
export const REFRESH_TTL_MS = 60 * DAY;
export const REFRESH_GRACE_MS = 30 * 1000;

const opaque = (prefix: string) => `${prefix}_${v7().replace(/-/g, '')}${v7().replace(/-/g, '')}`;

/** Issues a fresh access + refresh pair bound to `deviceId`. */
export function issueTokens(
  state: MockState,
  userId: string,
  deviceId: string,
  now: number,
): TokenPair {
  const accessToken = opaque('at');
  const refreshToken = opaque('rt');
  const accessExpiresAt = toIso(now + ACCESS_TTL_MS);
  state.accessTokens[accessToken] = { userId, deviceId, expiresAt: accessExpiresAt };
  state.refreshTokens[refreshToken] = {
    userId,
    deviceId,
    expiresAt: toIso(now + REFRESH_TTL_MS),
    revokedAt: null,
    rotatedAt: null,
    successor: null,
  };
  return { accessToken, refreshToken, accessExpiresAt };
}

/** Resolves `Authorization: Bearer …` to an active user, or null. Expired tokens are dropped. */
export function authenticate(
  state: MockState,
  authorization: string | undefined,
  now: number,
): UserRec | null {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  const token = m?.[1];
  if (!token) return null;
  const rec = state.accessTokens[token];
  if (!rec) return null;
  if (now >= fromIso(rec.expiresAt)) {
    delete state.accessTokens[token];
    return null;
  }
  const user = state.users.find((u) => u.id === rec.userId);
  return user && user.active ? user : null;
}

/**
 * Revokes every refresh token of the user. Access tokens behave like B1's stateless JWTs: they stay
 * valid until expiry, but every request re-checks that the user is still active.
 */
export function revokeAllForUser(state: MockState, userId: string, now: number): void {
  const at = toIso(now);
  for (const rec of Object.values(state.refreshTokens)) {
    if (rec.userId === userId && rec.revokedAt === null) rec.revokedAt = at;
  }
}

/** Removes expired access tokens and long-dead refresh tokens so the snapshot stays small. */
export function pruneTokens(state: MockState, now: number): void {
  for (const [k, rec] of Object.entries(state.accessTokens)) {
    if (now >= fromIso(rec.expiresAt)) delete state.accessTokens[k];
  }
  for (const [k, rec] of Object.entries(state.refreshTokens)) {
    if (now >= fromIso(rec.expiresAt)) delete state.refreshTokens[k];
  }
}
