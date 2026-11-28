import {
  dismissRejectionBodySchema,
  rejectionCountSchema,
  rejectionSchema,
  rejectionsQuerySchema,
  restoreRejectionResultSchema,
} from '@tonnage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute } from '../http/route.ts';
import { countRejections, dismissRejection, listRejections, restoreRejection } from '../services/dispatch/rejections.ts';

/** Needs attention (§6.5, B3 Task 8): weights the server refused, for the owner to restore or dismiss. */
export async function rejectionRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, 'GET', '/weighment-rejections', {
    action: 'rejections.manage',
    query: rejectionsQuerySchema,
    response: { 200: z.array(rejectionSchema) },
    async handler({ tx, query }) {
      return { body: await listRejections(tx, query.status) };
    },
  });

  // Before any /weighment-rejections/:id route.
  defineRoute(app, 'GET', '/weighment-rejections/count', {
    action: 'rejections.manage',
    response: { 200: rejectionCountSchema },
    async handler({ tx }) {
      return { body: await countRejections(tx) };
    },
  });

  defineRoute(app, 'POST', '/weighment-rejections/:id/restore', {
    action: 'rejections.manage',
    idempotent: true,
    response: { 200: restoreRejectionResultSchema },
    async handler({ tx, user, scope, now, params }) {
      return { body: await restoreRejection(tx, { user, scope, now }, params.id) };
    },
  });

  defineRoute(app, 'POST', '/weighment-rejections/:id/dismiss', {
    action: 'rejections.manage',
    idempotent: true,
    body: dismissRejectionBodySchema,
    response: { 200: rejectionSchema },
    async handler({ tx, user, scope, now, params, body }) {
      return { body: await dismissRejection(tx, { user, scope, now }, params.id, body.reason) };
    },
  });
}
