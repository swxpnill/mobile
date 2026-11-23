import { existsSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { systemClock } from './clock.ts';
import { createDb } from './db/client.ts';
import { loadEnv } from './env.ts';
import { buildApp } from './server.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv(process.env);
// The pool exists before the app (and its logger) does; route its errors to the app's log once it is up.
const sink: { log?: FastifyBaseLogger } = {};
const { db, close: closeDb } = createDb(env.DATABASE_URL, {
  log: {
    error: (obj, msg) => (sink.log ? sink.log.error(obj, msg) : console.error(msg, obj.err)),
  },
});
const app = await buildApp({ env, db, clock: systemClock });
sink.log = app.log;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
