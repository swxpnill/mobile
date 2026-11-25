import { homeQuerySchema, homeSchema } from '@tonnage/shared';
import type { FastifyPluginAsync } from 'fastify';
import { defineRoute } from '../http/route.ts';
import { loadHome } from '../services/home.ts';

/** `GET /v1/home`, as the mock: the caller's figures, optionally for one company. */
export const homeRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/home', {
    action: 'order.view',
    query: homeQuerySchema,
    response: { 200: homeSchema },
    handler: async ({ tx, user, scope, query, now }) => ({ body: await loadHome(tx, { user, scope, now }, query) }),
  });
};
