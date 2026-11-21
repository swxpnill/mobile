import rateLimit from '@fastify/rate-limit';
import {
  refreshBodySchema,
  requestCodeBodySchema,
  requestCodeResponseSchema,
  signOutBodySchema,
  tokenPairSchema,
  verifyCodeBodySchema,
} from '@tonnage/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OtpService } from '../auth/otp.service.ts';
import type { Tokens } from '../auth/tokens.ts';
import type { Clock } from '../clock.ts';
import type { Db } from '../db/client.ts';
import type { Env } from '../env.ts';
import { AppError } from '../http/errors.ts';

export interface AuthRouteDeps {
  env: Pick<Env, 'RATE_LIMIT'>;
  db: Db;
  clock: Clock;
  otp: OtpService;
  tokens: Tokens;
}

/** Public: the pipeline (Task 4) skips bearer auth for these. */
const PUBLIC = { public: true } as const;

/**
 * `POST /v1/auth/{request-code,verify,refresh,sign-out}`. Not wrapped in a request transaction: the
 * services commit refusals before throwing (Ruling 5).
 */
export const authRoutes = (deps: AuthRouteDeps): FastifyPluginAsyncZod => {
  return async (app) => {
    if (deps.env.RATE_LIMIT === 'on') {
      // Registered inside this plugin, so only `/v1/auth/*` is limited.
      await app.register(rateLimit, {
        max: 10,
        timeWindow: 60_000,
        errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED'),
      });
    }

    app.post(
      '/request-code',
      { config: PUBLIC, schema: { body: requestCodeBodySchema, response: { 200: requestCodeResponseSchema } } },
      async (req) => deps.otp.requestCode(req.body.mobile, deps.clock.now()),
    );

    app.post(
      '/verify',
      { config: PUBLIC, schema: { body: verifyCodeBodySchema, response: { 200: tokenPairSchema } } },
      async (req) => deps.otp.verify(req.body, deps.clock.now()),
    );

    app.post(
      '/refresh',
      { config: PUBLIC, schema: { body: refreshBodySchema, response: { 200: tokenPairSchema } } },
      async (req) =>
        deps.tokens.rotateRefresh(deps.db, req.body.refreshToken, req.body.deviceId, deps.clock.now()),
    );

    app.post(
      '/sign-out',
      { config: PUBLIC, schema: { body: signOutBodySchema, response: { 204: z.null() } } },
      async (req, reply) => {
        await deps.tokens.signOut(deps.db, req.body.refreshToken, deps.clock.now());
        return reply.code(204).send(null);
      },
    );
  };
};
