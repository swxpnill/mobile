import { randomBytes } from 'node:crypto';
import type { TokenPair } from '@tonnage/shared';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { withTenant, type Db, type Tx } from '../db/client.ts';
import { devices, refreshTokens, users } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { createSuccessorBox, hashesEqual, sha256Hex } from './crypto.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Same values as the mock (`mock-api/src/sessions.ts`). Every window is half-open. */
export const ACCESS_TTL_MS = 15 * MINUTE;
/** Rolling: each rotation issues a token that lasts this long from then. */
export const REFRESH_TTL_MS = 60 * DAY;
export const REFRESH_GRACE_MS = 30_000;

export interface AccessClaims {
  userId: string;
  tenantId: string;
  deviceId: string;
}

export interface TokenUser {
  id: string;
  tenantId: string;
}

export interface Tokens {
  issueAccess(user: TokenUser, deviceId: string, now: number): Promise<{ token: string; expiresAt: string }>;
  /** The claims of a valid HS256 access token at `now`, or null for anything else. */
  verifyAccess(token: string, now: number): Promise<AccessClaims | null>;
  /** Issues an access token and stores a new refresh token (hashed) for the user's device. */
  issuePair(tx: Tx, user: TokenUser, deviceId: string, now: number): Promise<TokenPair>;
  /**
   * Rotates a refresh token. A retry within the grace window gets the identical pair; reuse after it
   * revokes every refresh token of the user (committed) and is refused. Throws 401 UNAUTHENTICATED.
   */
  rotateRefresh(db: Db, token: string, deviceId: string, now: number): Promise<TokenPair>;
  /** Revokes every live refresh token of the user and drops any sealed successor. */
  revokeAllForUser(tx: Tx, userId: string, now: number): Promise<void>;
  /** Revokes this refresh token and clears its device's push token; an unknown token is a no-op. */
  signOut(db: Db, token: string, now: number): Promise<void>;
}

const refused = () => new AppError(401, 'UNAUTHENTICATED');
const newRefreshToken = () => `rt_${randomBytes(32).toString('base64url')}`;

export function createTokens(secret: string): Tokens {
  const key = new TextEncoder().encode(secret);
  const box = createSuccessorBox(secret);

  const issueAccess: Tokens['issueAccess'] = async (user, deviceId, now) => {
    // JWT times are whole seconds. Rounding the issue time down means the token never outlives the
    // expiry the app is told, and the window stays exactly 15 min, half-open.
    const iat = Math.floor(now / 1000);
    const exp = iat + ACCESS_TTL_MS / 1000;
    const token = await new SignJWT({ tid: user.tenantId, did: deviceId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  };

  const verifyAccess: Tokens['verifyAccess'] = async (token, now) => {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        currentDate: new Date(now),
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      const { sub, tid, did } = payload;
      if (typeof sub !== 'string' || typeof tid !== 'string' || typeof did !== 'string') return null;
      return { userId: sub, tenantId: tid, deviceId: did };
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) return null; // expired, forged, malformed
      throw error;
    }
  };

  const issuePair: Tokens['issuePair'] = async (tx, user, deviceId, now) => {
    const access = await issueAccess(user, deviceId, now);
    const refreshToken = newRefreshToken();
    const at = new Date(now);
    await tx.insert(refreshTokens).values({
      id: uuidv7(),
      tenantId: user.tenantId,
      userId: user.id,
      deviceId,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(now + REFRESH_TTL_MS),
      createdAt: at,
      updatedAt: at,
    });
    return { accessToken: access.token, refreshToken, accessExpiresAt: access.expiresAt };
  };

  const revokeAllForUser: Tokens['revokeAllForUser'] = async (tx, userId, now) => {
    const at = new Date(now);
    await tx
      .update(refreshTokens)
      .set({
        revokedAt: sql`coalesce(${refreshTokens.revokedAt}, ${at})`,
        successorEnc: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          or(isNull(refreshTokens.revokedAt), isNotNull(refreshTokens.successorEnc)),
        ),
      );
  };

  const rotateRefresh: Tokens['rotateRefresh'] = async (db, token, deviceId, now) => {
    const hash = sha256Hex(token);
    // A refusal returns (so its writes commit) and is thrown only after the commit (Ruling 5).
    const pair = await db.transaction(async (tx): Promise<TokenPair | null> => {
      // The row lock serialises concurrent refreshes of one token: the second waits, then sees the
      // rotation and takes the grace path (Review Focus 1).
      const [rec] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash))
        .for('update');
      if (!rec || !hashesEqual(rec.tokenHash, hash) || rec.deviceId !== deviceId) return null;
      if (now >= rec.expiresAt.getTime()) return null;

      return withTenant(tx, rec.tenantId, async (ttx) => {
        const [user] = await ttx
          .select({ active: users.active })
          .from(users)
          .where(eq(users.id, rec.userId));
        if (!user?.active) return null;

        if (rec.rotatedAt !== null) {
          if (now - rec.rotatedAt.getTime() < REFRESH_GRACE_MS && rec.successorEnc !== null) {
            const successor = box.openSuccessor(rec.successorEnc);
            const [live] = await ttx
              .select({ id: refreshTokens.id })
              .from(refreshTokens)
              .where(
                and(
                  eq(refreshTokens.tokenHash, sha256Hex(successor.refreshToken)),
                  isNull(refreshTokens.revokedAt),
                ),
              );
            if (live) return successor; // an identical retry within the grace window
          }
          // Reuse after the grace window: treat as theft. Also clears this row's sealed successor.
          await revokeAllForUser(ttx, rec.userId, now);
          return null;
        }
        if (rec.revokedAt !== null) return null;

        const next = await issuePair(ttx, { id: rec.userId, tenantId: rec.tenantId }, deviceId, now);
        await ttx
          .update(refreshTokens)
          .set({ rotatedAt: new Date(now), successorEnc: box.sealSuccessor(next), updatedAt: new Date(now) })
          .where(eq(refreshTokens.id, rec.id));
        return next;
      });
    });
    if (pair === null) throw refused();
    return pair;
  };

  const signOut: Tokens['signOut'] = async (db, token, now) => {
    const hash = sha256Hex(token);
    await db.transaction(async (tx) => {
      const [rec] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash))
        .for('update');
      if (!rec || !hashesEqual(rec.tokenHash, hash) || rec.revokedAt !== null) return;
      const at = new Date(now);
      await tx
        .update(refreshTokens)
        .set({ revokedAt: at, successorEnc: null, updatedAt: at })
        .where(eq(refreshTokens.id, rec.id));
      // Only if the phone is still this person's: it may have moved to someone who signed in since.
      await withTenant(tx, rec.tenantId, (ttx) =>
        ttx
          .update(devices)
          .set({ pushToken: null, updatedAt: at })
          .where(and(eq(devices.id, rec.deviceId), eq(devices.userId, rec.userId))),
      );
    });
  };

  return { issueAccess, verifyAccess, issuePair, rotateRefresh, revokeAllForUser, signOut };
}
