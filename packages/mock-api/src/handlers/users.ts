import { inviteUserBodySchema, plantRule, updateUserBodySchema, type Role } from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, notFound, stale } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import { revokeAllForUser } from '../sessions.ts';
import type { MockState, UserRec } from '../store.ts';
import { authed, logActivity, newId, toUser, type Authed } from '../views.ts';

/** Validates plant count for the role (422 PLANT_RULE) and that every plant is in the tenant (404). */
function checkPlants(
  state: MockState,
  tenantId: string,
  role: Role,
  plantIds: readonly string[],
): string[] {
  const unique = [...new Set(plantIds)];
  const rule = plantRule(role);
  if (unique.length < rule.min || unique.length > rule.max) {
    throw new ApiError(422, 'PLANT_RULE', {
      role,
      min: rule.min,
      max: rule.max === Infinity ? null : rule.max,
    });
  }
  for (const id of unique) {
    if (!state.plants.some((p) => p.id === id && p.tenantId === tenantId)) throw notFound();
  }
  return unique;
}

function findUser(state: MockState, a: Authed, id: string | undefined): UserRec {
  const u = state.users.find((x) => x.id === id && x.tenantId === a.user.tenantId);
  if (!u) throw notFound();
  return u;
}

/** Refuses a change that would leave the tenant without an active owner. */
function assertNotLastOwner(state: MockState, u: UserRec): void {
  if (u.role !== 'owner' || !u.active) return;
  const others = state.users.some(
    (x) => x.tenantId === u.tenantId && x.id !== u.id && x.role === 'owner' && x.active,
  );
  if (!others) throw new ApiError(409, 'LAST_OWNER');
}

export const userRoutes: RouteDef[] = [
  route('GET', '/v1/users', {
    action: 'users.manage',
    async handler(ctx) {
      const a = authed(ctx);
      return { body: ctx.state.users.filter((u) => u.tenantId === a.user.tenantId).map(toUser) };
    },
  }),

  route('POST', '/v1/users', {
    action: 'users.manage',
    idempotent: true,
    body: inviteUserBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const plantIds = checkPlants(state, a.user.tenantId, body.role, body.plantIds);
      if (state.users.some((u) => u.tenantId === a.user.tenantId && u.mobile === body.mobile)) {
        throw new ApiError(409, 'MOBILE_EXISTS');
      }
      const at = toIso(now);
      const rec: UserRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        name: body.name,
        mobile: body.mobile,
        role: body.role,
        plantIds,
        active: true,
        version: 1,
        preferences: { unitBasis: 'mt' },
        invitedAt: at,
        lastSeenAt: null,
        createdAt: at,
        updatedAt: at,
      };
      state.users.push(rec);
      logActivity(state, a, now, { entityType: 'user', entityId: rec.id, action: 'user.invited' });
      return { status: 201, body: toUser(rec) };
    },
  }),

  route('PATCH', '/v1/users/:id', {
    action: 'users.manage',
    body: updateUserBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const u = findUser(state, a, ctx.params.id);
      if (body.version !== u.version) throw stale();
      const role = body.role ?? u.role;
      const roleChanged = role !== u.role;
      // owner/city_staff hold no plants: switching to them clears plants unless some were sent.
      const requested = body.plantIds ?? (plantRule(role).max === 0 ? [] : u.plantIds);
      const plantIds = checkPlants(state, a.user.tenantId, role, requested);
      if (roleChanged && u.role === 'owner') assertNotLastOwner(state, u);

      if (body.name !== undefined) u.name = body.name;
      u.role = role;
      u.plantIds = plantIds;
      u.version += 1;
      u.updatedAt = toIso(now);
      logActivity(state, a, now, {
        entityType: 'user',
        entityId: u.id,
        action: 'user.updated',
        ...(roleChanged ? { meta: { role } } : {}),
      });
      return { body: toUser(u) };
    },
  }),

  route('POST', '/v1/users/:id/deactivate', {
    action: 'users.manage',
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      const u = findUser(state, a, ctx.params.id);
      if (u.active) {
        assertNotLastOwner(state, u);
        u.active = false;
        u.version += 1;
        u.updatedAt = toIso(now);
        revokeAllForUser(state, u.id, now);
        logActivity(state, a, now, {
          entityType: 'user',
          entityId: u.id,
          action: 'user.deactivated',
        });
      }
      return { body: toUser(u) };
    },
  }),

  route('POST', '/v1/users/:id/reactivate', {
    action: 'users.manage',
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      const u = findUser(state, a, ctx.params.id);
      if (!u.active) {
        u.active = true;
        u.version += 1;
        u.updatedAt = toIso(now);
        logActivity(state, a, now, {
          entityType: 'user',
          entityId: u.id,
          action: 'user.reactivated',
        });
      }
      return { body: toUser(u) };
    },
  }),
];
