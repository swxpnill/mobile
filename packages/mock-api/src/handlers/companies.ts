import { createCompanyBodySchema, updateCompanyBodySchema } from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { stale, validationError } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import type { CompanyRec, MockState } from '../store.ts';
import { authed, findCompany, logActivity, newId, toCompany, visibleCompanies } from '../views.ts';

function assertCodeFree(state: MockState, tenantId: string, code: string, exceptId?: string): void {
  if (
    state.companies.some((c) => c.tenantId === tenantId && c.code === code && c.id !== exceptId)
  ) {
    throw validationError([
      { path: ['code'], message: 'This code is already used by another company' },
    ]);
  }
}

/**
 * Hook called when a company goes active → inactive. No orders exist in M1, so it always passes;
 * F2 adds the "no non-terminal sub-orders" check here (spec §5.3).
 */
export function assertCompanyDeactivatable(state: MockState, company: CompanyRec): void {
  void state;
  void company;
}

export const companyRoutes: RouteDef[] = [
  route('GET', '/v1/companies', {
    action: 'self.view',
    async handler(ctx) {
      return { body: visibleCompanies(ctx.state, authed(ctx)).map(toCompany) };
    },
  }),

  route('GET', '/v1/companies/:id', {
    action: 'self.view',
    async handler(ctx) {
      return { body: toCompany(findCompany(ctx.state, authed(ctx), ctx.params.id)) };
    },
  }),

  route('POST', '/v1/companies', {
    action: 'companies.manage',
    idempotent: true,
    body: createCompanyBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      assertCodeFree(state, a.user.tenantId, body.code);
      const at = toIso(now);
      const rec: CompanyRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        code: body.code,
        name: body.name,
        gstin: body.gstin,
        orderPrefix: body.orderPrefix,
        active: true,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.companies.push(rec);
      logActivity(state, a, now, {
        entityType: 'company',
        entityId: rec.id,
        action: 'company.created',
      });
      return { status: 201, body: toCompany(rec) };
    },
  }),

  route('PATCH', '/v1/companies/:id', {
    action: 'companies.manage',
    body: updateCompanyBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = findCompany(state, a, ctx.params.id);
      if (body.version !== c.version) throw stale();
      if (body.code !== undefined) assertCodeFree(state, a.user.tenantId, body.code, c.id);
      if (c.active && body.active === false) assertCompanyDeactivatable(state, c);

      if (body.code !== undefined) c.code = body.code;
      if (body.name !== undefined) c.name = body.name;
      if (body.gstin !== undefined) c.gstin = body.gstin;
      if (body.orderPrefix !== undefined) c.orderPrefix = body.orderPrefix;
      if (body.active !== undefined) c.active = body.active;
      c.version += 1;
      c.updatedAt = toIso(now);
      logActivity(state, a, now, {
        entityType: 'company',
        entityId: c.id,
        action: 'company.updated',
      });
      return { body: toCompany(c) };
    },
  }),
];
