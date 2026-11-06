import type { Company, Me, Plant, PlantScope, User } from '@tonnage/shared';
import { v7 } from 'uuid';
import { toIso } from './clock.ts';
import { notFound, unauthenticated } from './errors.ts';
import type { HandlerCtx } from './router.ts';
import type { ActivityRec, CompanyRec, MockState, PlantRec, TenantRec, UserRec } from './store.ts';

// Serializers build fresh plain objects (never state references), so responses can't alias state.

export function toCompany(c: CompanyRec): Company {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    gstin: c.gstin,
    orderPrefix: c.orderPrefix,
    active: c.active,
    version: c.version,
  };
}

export function toPlant(p: PlantRec): Plant {
  return {
    id: p.id,
    companyId: p.companyId,
    name: p.name,
    location: p.location,
    active: p.active,
    version: p.version,
  };
}

export function userStatus(u: UserRec): User['status'] {
  if (!u.active) return 'inactive';
  return u.lastSeenAt === null ? 'invited' : 'active';
}

export function toUser(u: UserRec): User {
  return {
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    role: u.role,
    plantIds: [...u.plantIds],
    active: u.active,
    status: userStatus(u),
    version: u.version,
  };
}

export function toMe(u: UserRec, t: TenantRec): Me {
  return {
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    role: u.role,
    plantIds: [...u.plantIds],
    preferences: { unitBasis: u.preferences.unitBasis },
    tenant: { id: t.id, name: t.name },
  };
}

export interface Authed {
  user: UserRec;
  scope: PlantScope;
  tenant: TenantRec;
}

/** Narrows a non-public route's context. */
export function authed(ctx: HandlerCtx<unknown, unknown>): Authed {
  const { user, scope } = ctx;
  if (!user || !scope) throw unauthenticated();
  const tenant = ctx.state.tenants.find((t) => t.id === user.tenantId);
  if (!tenant) throw unauthenticated();
  return { user, scope, tenant };
}

const plantInScope = (scope: PlantScope, plantId: string) =>
  scope.kind === 'all' || scope.plantIds.includes(plantId);

/** Plants of the user's tenant within scope, in creation order. */
export function visiblePlants(state: MockState, a: Authed): PlantRec[] {
  return state.plants.filter((p) => p.tenantId === a.user.tenantId && plantInScope(a.scope, p.id));
}

/** Companies of the tenant; plant roles see only companies owning at least one of their plants. */
export function visibleCompanies(state: MockState, a: Authed): CompanyRec[] {
  const inTenant = state.companies.filter((c) => c.tenantId === a.user.tenantId);
  if (a.scope.kind === 'all') return inTenant;
  const owning = new Set(visiblePlants(state, a).map((p) => p.companyId));
  return inTenant.filter((c) => owning.has(c.id));
}

/** Company by id within tenant + scope; 404 otherwise (identical for missing and out of scope). */
export function findCompany(state: MockState, a: Authed, id: string | undefined): CompanyRec {
  const c = visibleCompanies(state, a).find((x) => x.id === id);
  if (!c) throw notFound();
  return c;
}

export function findPlant(state: MockState, a: Authed, id: string | undefined): PlantRec {
  const p = visiblePlants(state, a).find((x) => x.id === id);
  if (!p) throw notFound();
  return p;
}

export function newId(): string {
  return v7();
}

export function logActivity(
  state: MockState,
  a: Authed,
  now: number,
  e: Pick<ActivityRec, 'entityType' | 'entityId' | 'action'> & { meta?: Record<string, unknown> },
): void {
  const rec: ActivityRec = {
    id: newId(),
    tenantId: a.user.tenantId,
    entityType: e.entityType,
    entityId: e.entityId,
    action: e.action,
    actorId: a.user.id,
    at: toIso(now),
  };
  if (e.meta) rec.meta = e.meta;
  state.activity.push(rec);
}
