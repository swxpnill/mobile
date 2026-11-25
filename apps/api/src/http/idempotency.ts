import { IDEMPOTENCY_KEY_MESSAGE, isIdempotencyKey } from '@tonnage/shared';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { idempotencyKeys } from '../db/schema/index.ts';
import { AppError } from './errors.ts';

/** Same retention as the mock: a key is gone 24 h after it was first used, by the injected clock. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface KeySlot {
  tenantId: string;
  userId: string;
  key: string;
  /** `METHOD /pattern`, e.g. `POST /v1/plants`. */
  route: string;
}

export type Claim = { kind: 'run' } | { kind: 'replay'; status: number; body: unknown };

/**
 * Claims `(user, key)` for this request, inside the request's transaction, before the handler runs.
 * The key must follow the shared rule (1–128 of `A-Z a-z 0-9 _ . : -`), else 422 at `idempotency-key`.
 *
 * One statement takes the slot: a new key is inserted; a key whose row is older than 24 h is
 * re-claimed in place (`on conflict do update ... where created_at <= cutoff`: route, result and
 * timestamps replaced). A concurrent request with the same key blocks on that row until the first
 * one ends. If it committed, the row is fresh, the update's condition fails on the latest version,
 * and the stored result is replayed. If it rolled back (a failed handler, Ruling 7), the row is back
 * as it was (absent, or still expired) and this request takes it. Either way one handler runs, and a
 * result older than 24 h is never replayed: the lookup below ignores expired rows too.
 */
export async function claimKey(tx: Tx, slot: KeySlot, now: number): Promise<Claim> {
  if (!isIdempotencyKey(slot.key)) {
    throw new AppError(422, 'VALIDATION', [{ path: ['idempotency-key'], message: IDEMPOTENCY_KEY_MESSAGE }]);
  }
  const cutoff = new Date(now - IDEMPOTENCY_TTL_MS);
  // The user's other expired keys, as housekeeping. `skip locked`: a row another request is
  // purging or re-claiming at this moment is left to it, so two requests never wait on each other
  // here. This request's own key is re-claimed by the upsert below, never deleted and re-inserted.
  await tx.execute(sql`
    delete from ${idempotencyKeys}
    where (user_id, key) in (
      select user_id, key from ${idempotencyKeys}
      where user_id = ${slot.userId} and key <> ${slot.key} and created_at <= ${cutoff}
      for update skip locked
    )`);

  const at = new Date(now);
  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ ...slot, status: null, body: null, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [idempotencyKeys.userId, idempotencyKeys.key],
      set: { route: slot.route, status: null, body: null, createdAt: at, updatedAt: at },
      setWhere: lte(idempotencyKeys.createdAt, cutoff),
    })
    .returning({ key: idempotencyKeys.key });
  if (claimed.length > 0) return { kind: 'run' };

  const [stored] = await tx
    .select({ route: idempotencyKeys.route, status: idempotencyKeys.status, body: idempotencyKeys.body })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, slot.userId),
        eq(idempotencyKeys.key, slot.key),
        gt(idempotencyKeys.createdAt, cutoff),
      ),
    );
  if (stored && stored.route !== slot.route) {
    throw new AppError(422, 'VALIDATION', [
      { path: ['idempotency-key'], message: 'This key was already used for another request' },
    ]);
  }
  // Committed rows always carry a result (only a 2xx commits). Kept for safety: a row we cannot see
  // or one without a result means another request still holds the key.
  if (!stored || stored.status === null) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS');
  return { kind: 'replay', status: stored.status, body: stored.body };
}

/** Stores the 2xx result on the claimed row; it commits with the handler's writes. */
export async function storeResult(
  tx: Tx,
  slot: Pick<KeySlot, 'userId' | 'key'>,
  status: number,
  body: unknown,
  now: number,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ status, body: body ?? null, updatedAt: new Date(now) })
    .where(and(eq(idempotencyKeys.userId, slot.userId), eq(idempotencyKeys.key, slot.key)));
}
