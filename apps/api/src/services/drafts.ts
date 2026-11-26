import { and, asc, desc, eq, lt, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../db/client.ts';
import { drafts, users } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { AppError } from '../http/errors.ts';
import type { DraftRow } from '../views/drafts.ts';
import { anyId } from './orderGraph.ts';
import { isId } from './org.ts';

const DAY = 24 * 60 * 60 * 1000;

/** Drafts are purged 7 days after their last save (spec 5.3). */
export const DRAFT_TTL_MS = 7 * DAY;

/** A draft belongs to its creator; the owner may open anyone's (row-level security keeps the tenant). */
export function visibleDraft(user: AuthedUser): SQL | undefined {
  return user.role === 'owner' ? undefined : eq(drafts.createdBy, user.id);
}

/** Saves a new draft (version 1) for the caller. The payload is stored as given (jsonb). */
export async function createDraft(
  tx: Tx,
  user: AuthedUser,
  payload: Record<string, unknown>,
  now: number,
): Promise<DraftRow> {
  const at = new Date(now);
  const [row] = await tx
    .insert(drafts)
    .values({ id: uuidv7(), tenantId: user.tenantId, createdBy: user.id, payload, createdAt: at, updatedAt: at })
    .returning();
  if (!row) throw new Error('draft insert returned no row');
  return row;
}

/** Booking from a draft consumes it; a draft already purged or someone else's is left alone (as the mock). */
export async function deleteDraftIfVisible(tx: Tx, user: AuthedUser, id: string): Promise<void> {
  await tx.delete(drafts).where(and(eq(drafts.id, id), visibleDraft(user)));
}

/**
 * Drops the caller's drafts last saved more than 7 days before `now`, in one statement. Run at the
 * start of every drafts request (there is no job yet); other people's drafts are theirs to purge.
 */
export async function purgeExpiredDrafts(tx: Tx, user: AuthedUser, now: number): Promise<void> {
  await tx.delete(drafts).where(and(visibleDraft(user), lt(drafts.updatedAt, new Date(now - DRAFT_TTL_MS))));
}

/** Names of the people who saved these drafts, one query. */
export async function draftCreatorNames(tx: Tx, rows: readonly DraftRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.createdBy))];
  if (ids.length === 0) return new Map();
  const found = await tx.select({ id: users.id, name: users.name }).from(users).where(anyId(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name]));
}

/** The caller's drafts, most recently saved first (ties in creation order, as the mock's stable sort). */
export async function listDrafts(tx: Tx, user: AuthedUser, now: number): Promise<DraftRow[]> {
  await purgeExpiredDrafts(tx, user, now);
  return tx.select().from(drafts).where(visibleDraft(user)).orderBy(desc(drafts.updatedAt), asc(drafts.id));
}

/**
 * One draft the caller may open; 404 when it is missing, someone else's or expired. `lock` takes
 * the row FOR UPDATE, for a save or a delete.
 */
export async function findDraft(
  tx: Tx,
  user: AuthedUser,
  now: number,
  id: string | undefined,
  lock = false,
): Promise<DraftRow> {
  await purgeExpiredDrafts(tx, user, now);
  if (!isId(id)) throw new AppError(404, 'NOT_FOUND');
  const query = tx.select().from(drafts).where(and(eq(drafts.id, id), visibleDraft(user)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

/** Replaces the payload and bumps the version; a `version` that is not the stored one is 409 STALE. */
export async function saveDraft(
  tx: Tx,
  user: AuthedUser,
  now: number,
  id: string | undefined,
  payload: Record<string, unknown>,
  version: number | undefined,
): Promise<DraftRow> {
  const current = await findDraft(tx, user, now, id, true);
  if (version !== undefined && version !== current.version) throw new AppError(409, 'STALE');
  const [row] = await tx
    .update(drafts)
    .set({ payload, version: current.version + 1, updatedAt: new Date(now) })
    .where(eq(drafts.id, current.id))
    .returning();
  if (!row) throw new Error('draft update returned no row');
  return row;
}

export async function removeDraft(tx: Tx, user: AuthedUser, now: number, id: string | undefined): Promise<void> {
  const current = await findDraft(tx, user, now, id, true);
  await tx.delete(drafts).where(eq(drafts.id, current.id));
}
