import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from './clock.ts';
import type { Db } from './db/client.ts';
import type { Env } from './env.ts';
import { registerErrorHandling, zodValidatorCompiler } from './http/errors.ts';
import { metaRoutes } from './routes/meta.ts';

/** Sends one-time codes. Task 3 defines the dev provider. */
export interface OtpProvider {
  send(mobile: string, code: string): Promise<void>;
}

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
  });
  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(metaRoutes({ env, clock: deps.clock }), { prefix: '/v1' });
  return app;
}
