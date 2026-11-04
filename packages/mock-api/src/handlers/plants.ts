import { createPlantBodySchema, idSchema, updatePlantBodySchema } from '@tonnage/shared';
import { z } from 'zod';
import { toIso } from '../clock.ts';
import { stale } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import type { PlantRec } from '../store.ts';
import {
  authed,
  findCompany,
  findPlant,
  logActivity,
  newId,
  toPlant,
  visiblePlants,
} from '../views.ts';

const listPlantsQuerySchema = z.object({ companyId: idSchema.optional() });

export const plantRoutes: RouteDef[] = [
  route('GET', '/v1/plants', {
    action: 'self.view',
    query: listPlantsQuerySchema,
    async handler(ctx) {
      const { companyId } = ctx.query;
      const plants = visiblePlants(ctx.state, authed(ctx));
      // A company outside tenant or scope simply yields [] (no existence leak).
      const filtered =
        companyId === undefined ? plants : plants.filter((p) => p.companyId === companyId);
      return { body: filtered.map(toPlant) };
    },
  }),

  route('GET', '/v1/plants/:id', {
    action: 'self.view',
    async handler(ctx) {
      return { body: toPlant(findPlant(ctx.state, authed(ctx), ctx.params.id)) };
    },
  }),

  route('POST', '/v1/plants', {
    action: 'companies.manage',
    idempotent: true,
    body: createPlantBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const company = findCompany(state, a, body.companyId);
      const at = toIso(now);
      const rec: PlantRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        companyId: company.id,
        name: body.name,
        location: body.location,
        active: true,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.plants.push(rec);
      logActivity(state, a, now, {
        entityType: 'plant',
        entityId: rec.id,
        action: 'plant.created',
      });
      return { status: 201, body: toPlant(rec) };
    },
  }),

  route('PATCH', '/v1/plants/:id', {
    action: 'companies.manage',
    body: updatePlantBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const p = findPlant(state, a, ctx.params.id);
      if (body.version !== p.version) throw stale();
      if (body.companyId !== undefined) p.companyId = findCompany(state, a, body.companyId).id;
      if (body.name !== undefined) p.name = body.name;
      if (body.location !== undefined) p.location = body.location;
      if (body.active !== undefined) p.active = body.active;
      p.version += 1;
      p.updatedAt = toIso(now);
      logActivity(state, a, now, { entityType: 'plant', entityId: p.id, action: 'plant.updated' });
      return { body: toPlant(p) };
    },
  }),
];
