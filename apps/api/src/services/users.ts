import { plantRule, type Role } from '@tonnage/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { pgError } from '../db/pg-error.ts';
import { plants, userPlants, users } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { isId } from './org.ts';

export type UserRow = typeof users.$inferSelect;

/**
 * Unique plant ids counted against the role's rule (422 PLANT_RULE, `max: null` when unbounded), then
 * checked to exist in the tenant (404). Returns the unique ids, sorted.
 */
export async function checkPlants(
  tx: Tx,
  tenantId: string,
  role: Role,
  plantIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(plantIds)];
  const rule = plantRule(role);
  if (unique.length < rule.min || unique.length > rule.max) {
    throw new AppError(422, 'PLANT_RULE', {
      role,
      min: rule.min,
      max: rule.max === Infinity ? null : rule.max,
    });
  }
  if (unique.length > 0) {
    const found = await tx
      .select({ id: plants.id })
      .from(plants)
      .where(and(eq(plants.tenantId, tenantId), inArray(plants.id, unique)));
    if (found.length !== unique.length) throw new AppError(404, 'NOT_FOUND');
  }
  return unique.sort();
}

/** The plant ids of each given user (sorted). */
export async function plantIdsByUser(tx: Tx, userIds: readonly string[]): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (userIds.length === 0) return byUser;
  const rows = await tx
    .select({ userId: userPlants.userId, plantId: userPlants.plantId })
    .from(userPlants)
    .where(inArray(userPlants.userId, [...userIds]))
    .orderBy(asc(userPlants.plantId));
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.plantId]);
  return byUser;
}

export async function plantIdsOf(tx: Tx, userId: string): Promise<string[]> {
  return (await plantIdsByUser(tx, [userId])).get(userId) ?? [];
}

/** Replaces a user's plants. */
export async function setUserPlants(
  tx: Tx,
  tenantId: string,
  userId: string,
  plantIds: readonly string[],
  now: number,
): Promise<void> {
  const at = new Date(now);
  await tx.delete(userPlants).where(eq(userPlants.userId, userId));
  if (plantIds.length > 0) {
    await tx
      .insert(userPlants)
      .values(plantIds.map((plantId) => ({ tenantId, userId, plantId, createdAt: at, updatedAt: at })));
  }
}

/**
 * Locks every active owner of the tenant (`for no key update`, in id order), and returns their ids. Every route that can
 * remove an owner takes this lock before the target user's own lock, so two of them never wait on
 * each other in opposite orders, and the second sees the first's committed change. NO KEY UPDATE, not UPDATE: it still conflicts
 * with itself, but not with the FOR KEY SHARE an activity or idempotency insert takes on its actor.
 */
export async function lockActiveOwners(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, 'owner'), eq(users.active, true)))
    .orderBy(asc(users.id))
    .for('no key update');
  return rows.map((r) => r.id);
}

/** 409 LAST_OWNER when `userId` is the only active owner (ids from `lockActiveOwners`). */
export function assertNotLastOwner(activeOwnerIds: readonly string[], userId: string): void {
  if (activeOwnerIds.length === 1 && activeOwnerIds[0] === userId) throw new AppError(409, 'LAST_OWNER');
}

/** The tenant's user by id with a row lock (`for no key update`); 404 when missing or foreign. */
export async function lockUser(tx: Tx, tenantId: string, id: string | undefined): Promise<UserRow> {
  if (!isId(id)) throw new AppError(404, 'NOT_FOUND');
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
    .for('no key update');
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

/** Runs an invite write; a unique violation on (tenant_id, mobile) becomes 409 MOBILE_EXISTS. */
export async function withMobileUniqueness<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === 'users_tenant_id_mobile_key') {
      throw new AppError(409, 'MOBILE_EXISTS');
    }
    throw e;
  }
}
