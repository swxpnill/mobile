import rateLimit from '@fastify/rate-limit';
import {
  refreshBodySchema,
  requestCodeBodySchema,
  requestCodeResponseSchema,
  signOutBodySchema,
  tokenPairSchema,
  verifyCodeBodySchema,
} from '@tonnage/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { OtpService } from '../auth/otp.service.ts';
import type { Tokens } from '../auth/tokens.ts';
import type { Env } from '../env.ts';
import { AppError } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';

export interface AuthRouteDeps {
  env: Pick<Env, 'RATE_LIMIT'>;
  otp: OtpService;
  tokens: Tokens;
}

/**
 * `POST /v1/auth/{request-code,verify,refresh,sign-out}`. Public, so not wrapped in a request
 * transaction: the services commit refusals before throwing (Ruling 5).
 */
export const authRoutes = (deps: AuthRouteDeps): FastifyPluginAsync => {
  return async (app) => {
    if (deps.env.RATE_LIMIT === 'on') {
      // Registered inside this plugin, so only `/v1/auth/*` is limited.
      await app.register(rateLimit, {
        max: 10,
        timeWindow: 60_000,
        errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED'),
      });
    }

    defineRoute(app, 'POST', '/request-code', {
      public: true,
      body: requestCodeBodySchema,
      response: { 200: requestCodeResponseSchema },
      handler: async ({ body, now }) => ({ body: await deps.otp.requestCode(body.mobile, now) }),
    });

    defineRoute(app, 'POST', '/verify', {
      public: true,
      body: verifyCodeBodySchema,
      response: { 200: tokenPairSchema },
      handler: async ({ body, now }) => ({ body: await deps.otp.verify(body, now) }),
    });

    defineRoute(app, 'POST', '/refresh', {
      public: true,
      body: refreshBodySchema,
      response: { 200: tokenPairSchema },
      handler: async ({ db, body, now }) => ({
        body: await deps.tokens.rotateRefresh(db, body.refreshToken, body.deviceId, now),
      }),
    });

    defineRoute(app, 'POST', '/sign-out', {
      public: true,
      body: signOutBodySchema,
      response: { 204: z.null() },
      handler: async ({ db, body, now }) => {
        await deps.tokens.signOut(db, body.refreshToken, now);
        return { status: 204 };
      },
    });
  };
};
