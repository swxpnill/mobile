import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { serializerCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { DevOtpProvider, type OtpProvider } from './auth/otp-provider.ts';
import { createOtpService } from './auth/otp.service.ts';
import { createTokens } from './auth/tokens.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db/client.ts';
import type { Env } from './env.ts';
import { registerBodyParsers } from './http/body-parser.ts';
import { registerErrorHandling, zodValidatorCompiler } from './http/errors.ts';
import { registerPipeline } from './http/route.ts';
import { authRoutes } from './routes/auth.ts';
import { companyRoutes } from './routes/companies.ts';
import { metaRoutes } from './routes/meta.ts';
import { plantRoutes } from './routes/plants.ts';
import { settingsRoutes } from './routes/settings.ts';

export interface AppDeps {
  env: Env;
  db: Db;
  clock: Clock;
  otp?: OtpProvider;
  /** Where log lines go (tests capture them); defaults to stdout. */
  logStream?: DestinationStream;
}

const REDACT = [
  'req.headers.authorization',
  'headers.authorization',
  'req.body.code',
  'req.body.refreshToken',
  'body.code',
  'body.refreshToken',
];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: REDACT,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => uuidv7(),
    // One completion line per request comes from the onResponse hook below instead.
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  registerBodyParsers(app);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  // Never headers or bodies: only who, which route, the outcome and how long it took.
  app.addHook('onResponse', async (request, reply) => {
    const routeUrl = request.routeOptions.url;
    request.log.info(
      {
        tenantId: request.auth?.claims.tenantId ?? null,
        userId: request.auth?.claims.userId ?? null,
        route: routeUrl === undefined ? null : `${request.method} ${routeUrl}`,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  const tokens = createTokens(env.JWT_SECRET);
  registerPipeline(app, { db: deps.db, clock: deps.clock, tokens });
  const otp = createOtpService({
    db: deps.db,
    env,
    otp: deps.otp ?? new DevOtpProvider(app.log),
    tokens,
  });

  await app.register(metaRoutes({ env }), { prefix: '/v1' });
  await app.register(companyRoutes, { prefix: '/v1' });
  await app.register(plantRoutes, { prefix: '/v1' });
  await app.register(settingsRoutes, { prefix: '/v1' });
  await app.register(authRoutes({ env, otp, tokens }), {
    prefix: '/v1/auth',
  });
  return app;
}
