import { companySchema, createCompanyBodySchema, updateCompanyBodySchema } from '@tonnage/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { companies } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import {
  assertCompanyDeactivatable,
  findCompany,
  visibleCompanies,
  withCodeUniqueness,
} from '../services/org.ts';
import { toCompany } from '../views/org.ts';

/** `GET|POST /v1/companies`, `GET|PATCH /v1/companies/:id`. */
export const companyRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/companies', {
    action: 'self.view',
    response: { 200: z.array(companySchema) },
    handler: async ({ tx, scope }) => ({ body: (await visibleCompanies(tx, scope)).map(toCompany) }),
  });

  defineRoute(app, 'GET', '/companies/:id', {
    action: 'self.view',
    response: { 200: companySchema },
    handler: async ({ tx, scope, params }) => ({ body: toCompany(await findCompany(tx, scope, params.id)) }),
  });

  defineRoute(app, 'POST', '/companies', {
    action: 'companies.manage',
    idempotent: true,
    body: createCompanyBodySchema,
    response: { 201: companySchema },
    handler: async ({ tx, user, body, now }) => {
      const at = new Date(now);
      const [row] = await withCodeUniqueness(() =>
        tx
          .insert(companies)
          .values({
            id: uuidv7(),
            tenantId: user.tenantId,
            code: body.code,
            name: body.name,
            gstin: body.gstin,
            orderPrefix: body.orderPrefix,
            createdAt: at,
            updatedAt: at,
          })
          .returning(),
      );
      if (!row) throw new Error('company insert returned no row');
      await logActivity(tx, user, now, { entityType: 'company', entityId: row.id, action: 'company.created' });
      return { status: 201, body: toCompany(row) };
    },
  });

  defineRoute(app, 'PATCH', '/companies/:id', {
    action: 'companies.manage',
    body: updateCompanyBodySchema,
    response: { 200: companySchema },
    handler: async ({ tx, user, scope, params, body, now }) => {
      const current = await findCompany(tx, scope, params.id);
      const { version, ...fields } = body;
      if (current.version !== version) throw new AppError(409, 'STALE');
      if (current.active && fields.active === false) await assertCompanyDeactivatable(tx, current.id);
      const [row] = await withCodeUniqueness(() =>
        tx
          .update(companies)
          .set({ ...fields, version: version + 1, updatedAt: new Date(now) })
          .where(and(eq(companies.id, current.id), eq(companies.version, version)))
          .returning(),
      );
      // Zero rows: a concurrent write bumped the version after the read above.
      if (!row) throw new AppError(409, 'STALE');
      await logActivity(tx, user, now, { entityType: 'company', entityId: row.id, action: 'company.updated' });
      return { body: toCompany(row) };
    },
  });
};
