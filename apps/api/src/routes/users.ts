import { inviteUserBodySchema, updateUserBodySchema, userSchema } from '@tonnage/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { Tokens } from '../auth/tokens.ts';
import { users } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import {
  assertNotLastOwner,
  checkPlants,
  lockActiveOwners,
  lockUser,
  plantIdsByUser,
  plantIdsOf,
  setUserPlants,
  withMobileUniqueness,
} from '../services/users.ts';
import { toUser } from '../views/users.ts';

/** `GET|POST /v1/users`, `PATCH /v1/users/:id`, `POST /v1/users/:id/deactivate|reactivate`. */
export function userRoutes({ tokens }: { tokens: Tokens }): FastifyPluginAsync {
  return async (app) => {
    defineRoute(app, 'GET', '/users', {
      action: 'users.manage',
      response: { 200: z.array(userSchema) },
      handler: async ({ tx, user }) => {
        const rows = await tx
          .select()
          .from(users)
          .where(eq(users.tenantId, user.tenantId))
          .orderBy(asc(users.createdAt), asc(users.id));
        const plantIds = await plantIdsByUser(
          tx,
          rows.map((r) => r.id),
        );
        return { body: rows.map((r) => toUser(r, plantIds.get(r.id) ?? [])) };
      },
    });

    defineRoute(app, 'POST', '/users', {
      action: 'users.manage',
      idempotent: true,
      body: inviteUserBodySchema,
      response: { 201: userSchema },
      handler: async ({ tx, user, body, now }) => {
        const plantIds = await checkPlants(tx, user.tenantId, body.role, body.plantIds);
        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.tenantId, user.tenantId), eq(users.mobile, body.mobile)));
        if (existing) throw new AppError(409, 'MOBILE_EXISTS');
        const at = new Date(now);
        // The existence check above cannot see an invite still in flight; the unique index decides.
        const row = await withMobileUniqueness(async () => {
          const [inserted] = await tx
            .insert(users)
            .values({
              id: uuidv7(),
              tenantId: user.tenantId,
              name: body.name,
              mobile: body.mobile,
              role: body.role,
              invitedAt: at,
              createdAt: at,
              updatedAt: at,
            })
            .returning();
          if (!inserted) throw new Error('user insert returned no row');
          return inserted;
        });
        await setUserPlants(tx, user.tenantId, row.id, plantIds, now);
        await logActivity(tx, user, now, { entityType: 'user', entityId: row.id, action: 'user.invited' });
        return { status: 201, body: toUser(row, plantIds) };
      },
    });

    defineRoute(app, 'PATCH', '/users/:id', {
      action: 'users.manage',
      body: updateUserBodySchema,
      response: { 200: userSchema },
      handler: async ({ tx, user, params, body, now }) => {
        // Owners first, then the target: the one lock order every owner-affecting route uses.
        const owners = await lockActiveOwners(tx, user.tenantId);
        const current = await lockUser(tx, user.tenantId, params.id);
        if (current.version !== body.version) throw new AppError(409, 'STALE');
        const role = body.role ?? current.role;
        const roleChanged = role !== current.role;
        // Owner and city staff hold no plants: switching to them clears plants unless some were sent.
        const noPlants = role === 'owner' || role === 'city_staff';
        const requested = body.plantIds ?? (noPlants ? [] : await plantIdsOf(tx, current.id));
        const plantIds = await checkPlants(tx, user.tenantId, role, requested);
        if (roleChanged && current.role === 'owner') assertNotLastOwner(owners, current.id);
        const [row] = await tx
          .update(users)
          .set({ name: body.name ?? current.name, role, version: current.version + 1, updatedAt: new Date(now) })
          .where(and(eq(users.id, current.id), eq(users.version, body.version)))
          .returning();
        if (!row) throw new AppError(409, 'STALE');
        await setUserPlants(tx, user.tenantId, row.id, plantIds, now);
        await logActivity(tx, user, now, {
          entityType: 'user',
          entityId: row.id,
          action: 'user.updated',
          ...(roleChanged ? { meta: { role } } : {}),
        });
        return { body: toUser(row, plantIds) };
      },
    });

    defineRoute(app, 'POST', '/users/:id/deactivate', {
      action: 'users.manage',
      response: { 200: userSchema },
      handler: async ({ tx, user, params, now }) => {
        const owners = await lockActiveOwners(tx, user.tenantId);
        const current = await lockUser(tx, user.tenantId, params.id);
        if (!current.active) return { body: toUser(current, await plantIdsOf(tx, current.id)) };
        if (current.role === 'owner') assertNotLastOwner(owners, current.id);
        // The row lock is already held (lockUser); revokeAllForUser requires it before it runs.
        const [row] = await tx
          .update(users)
          .set({ active: false, version: current.version + 1, updatedAt: new Date(now) })
          .where(eq(users.id, current.id))
          .returning();
        if (!row) throw new Error('user update returned no row');
        await tokens.revokeAllForUser(tx, row.id, now);
        await logActivity(tx, user, now, { entityType: 'user', entityId: row.id, action: 'user.deactivated' });
        return { body: toUser(row, await plantIdsOf(tx, row.id)) };
      },
    });

    defineRoute(app, 'POST', '/users/:id/reactivate', {
      action: 'users.manage',
      response: { 200: userSchema },
      handler: async ({ tx, user, params, now }) => {
        await lockActiveOwners(tx, user.tenantId); // same lock order as the other user-admin writes
        const current = await lockUser(tx, user.tenantId, params.id);
        if (current.active) return { body: toUser(current, await plantIdsOf(tx, current.id)) };
        const [row] = await tx
          .update(users)
          .set({ active: true, version: current.version + 1, updatedAt: new Date(now) })
          .where(eq(users.id, current.id))
          .returning();
        if (!row) throw new Error('user update returned no row');
        await logActivity(tx, user, now, { entityType: 'user', entityId: row.id, action: 'user.reactivated' });
        return { body: toUser(row, await plantIdsOf(tx, row.id)) };
      },
    });
  };
}
