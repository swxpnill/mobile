import { draftBodySchema, draftSchema } from '@tonnage/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { defineRoute } from '../http/route.ts';
import {
  createDraft,
  draftCreatorNames,
  findDraft,
  listDrafts,
  purgeExpiredDrafts,
  removeDraft,
  saveDraft,
} from '../services/drafts.ts';
import { toDraft } from '../views/drafts.ts';

/**
 * `/v1/orders/drafts…`, as the mock: a draft is its creator's (the owner may open anyone's), a
 * save carries the version it read, and drafts untouched for 7 days are purged on every request.
 */
export const draftRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/orders/drafts', {
    action: 'order.create',
    response: { 200: z.array(draftSchema) },
    handler: async ({ tx, user, now }) => {
      const rows = await listDrafts(tx, user, now);
      const names = await draftCreatorNames(tx, rows);
      return { body: rows.map((r) => toDraft(r, names.get(r.createdBy) ?? '')) };
    },
  });

  defineRoute(app, 'POST', '/orders/drafts', {
    action: 'order.create',
    idempotent: true,
    body: draftBodySchema,
    response: { 201: draftSchema },
    handler: async ({ tx, user, body, now }) => {
      await purgeExpiredDrafts(tx, user, now);
      return { status: 201, body: toDraft(await createDraft(tx, user, body.payload, now), user.name) };
    },
  });

  defineRoute(app, 'GET', '/orders/drafts/:id', {
    action: 'order.create',
    response: { 200: draftSchema },
    handler: async ({ tx, user, params, now }) => {
      const row = await findDraft(tx, user, now, params.id);
      const names = await draftCreatorNames(tx, [row]);
      return { body: toDraft(row, names.get(row.createdBy) ?? '') };
    },
  });

  defineRoute(app, 'PUT', '/orders/drafts/:id', {
    action: 'order.create',
    body: draftBodySchema,
    response: { 200: draftSchema },
    handler: async ({ tx, user, params, body, now }) => {
      const row = await saveDraft(tx, user, now, params.id, body.payload, body.version);
      const names = await draftCreatorNames(tx, [row]);
      return { body: toDraft(row, names.get(row.createdBy) ?? '') };
    },
  });

  defineRoute(app, 'DELETE', '/orders/drafts/:id', {
    action: 'order.create',
    handler: async ({ tx, user, params, now }) => {
      await removeDraft(tx, user, now, params.id);
      return { status: 204 };
    },
  });
};
