import { metaSchema } from '@tonnage/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Clock } from '../clock.ts';
import type { Env } from '../env.ts';

/** `GET /v1/meta` (public): the minimum supported app version and the server's clock. */
export const metaRoutes = (deps: { env: Env; clock: Clock }): FastifyPluginAsyncZod => {
  return async (app) => {
    app.get('/meta', { schema: { response: { 200: metaSchema } } }, async () => ({
      minSupportedVersion: deps.env.MIN_SUPPORTED_APP_VERSION,
      serverTime: new Date(deps.clock.now()).toISOString(),
    }));
  };
};
