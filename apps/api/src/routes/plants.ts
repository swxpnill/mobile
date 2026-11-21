import {
  createPlantBodySchema,
  idSchema,
  plantSchema,
  updatePlantBodySchema,
} from '@tonnage/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { plants } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import { findCompany, findPlant, visiblePlants } from '../services/org.ts';
import { toPlant } from '../views/org.ts';

const listPlantsQuerySchema = z.object({ companyId: idSchema.optional() });

/** `GET|POST /v1/plants`, `GET|PATCH /v1/plants/:id`. */
export const plantRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/plants', {
    action: 'self.view',
    query: listPlantsQuerySchema,
    response: { 200: z.array(plantSchema) },
    // A company outside tenant or scope simply yields [] (no existence leak).
    handler: async ({ tx, scope, query }) => ({
      body: (await visiblePlants(tx, scope, query.companyId)).map(toPlant),
    }),
  });

  defineRoute(app, 'GET', '/plants/:id', {
    action: 'self.view',
    response: { 200: plantSchema },
    handler: async ({ tx, scope, params }) => ({ body: toPlant(await findPlant(tx, scope, params.id)) }),
  });

  defineRoute(app, 'POST', '/plants', {
    action: 'companies.manage',
    idempotent: true,
    body: createPlantBodySchema,
    response: { 201: plantSchema },
    handler: async ({ tx, user, scope, body, now }) => {
      const company = await findCompany(tx, scope, body.companyId);
      const at = new Date(now);
      const [row] = await tx
        .insert(plants)
        .values({
          id: uuidv7(),
          tenantId: user.tenantId,
          companyId: company.id,
          name: body.name,
          location: body.location,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error('plant insert returned no row');
      await logActivity(tx, user, now, { entityType: 'plant', entityId: row.id, action: 'plant.created' });
      return { status: 201, body: toPlant(row) };
    },
  });

  defineRoute(app, 'PATCH', '/plants/:id', {
    action: 'companies.manage',
    body: updatePlantBodySchema,
    response: { 200: plantSchema },
    handler: async ({ tx, user, scope, params, body, now }) => {
      const current = await findPlant(tx, scope, params.id);
      const { version, ...fields } = body;
      if (current.version !== version) throw new AppError(409, 'STALE');
      if (fields.companyId !== undefined) fields.companyId = (await findCompany(tx, scope, fields.companyId)).id;
      const [row] = await tx
        .update(plants)
        .set({ ...fields, version: version + 1, updatedAt: new Date(now) })
        .where(and(eq(plants.id, current.id), eq(plants.version, version)))
        .returning();
      if (!row) throw new AppError(409, 'STALE');
      await logActivity(tx, user, now, { entityType: 'plant', entityId: row.id, action: 'plant.updated' });
      return { body: toPlant(row) };
    },
  });
};
