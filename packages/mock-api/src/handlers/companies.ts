import { createCompanyBodySchema, isTerminal, updateCompanyBodySchema } from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, stale, validationError } from '../errors.ts';
import { orderMath } from '../orders-math.ts';
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

/** A company with open or partly dispatched sub-orders cannot be deactivated (spec §5.3). */
export function assertCompanyDeactivatable(state: MockState, company: CompanyRec): void {
  const subs = state.subOrders.filter((s) => s.companyId === company.id);
  if (subs.length === 0) return;
  const math = orderMath(state);
  const open = subs.filter((s) => !isTerminal(math.subOrderStatus(s)));
  if (open.length > 0) throw new ApiError(409, 'COMPANY_HAS_OPEN_ORDERS', { openSubOrders: open.length });
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
