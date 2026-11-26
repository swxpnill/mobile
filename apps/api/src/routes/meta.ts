import { metaSchema } from '@tonnage/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../env.ts';
import { defineRoute } from '../http/route.ts';
import pkg from '../../package.json' with { type: 'json' };

/** `GET /v1/meta` (public): the minimum supported app version, the server's clock and its version. */
export const metaRoutes = (deps: { env: Env }): FastifyPluginAsync => {
  return async (app) => {
    defineRoute(app, 'GET', '/meta', {
      public: true,
      response: { 200: metaSchema },
      handler: async ({ now }) => ({
        body: {
          minSupportedVersion: deps.env.MIN_SUPPORTED_APP_VERSION,
          serverTime: new Date(now).toISOString(),
          apiVersion: pkg.version,
        },
      }),
    });
  };
};
