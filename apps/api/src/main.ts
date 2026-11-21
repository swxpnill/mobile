import { existsSync } from 'node:fs';
import { systemClock } from './clock.ts';
import { createDb } from './db/client.ts';
import { loadEnv } from './env.ts';
import { buildApp } from './server.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv(process.env);
const db = createDb(env.DATABASE_URL);
const app = await buildApp({ env, db, clock: systemClock });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await db.$client.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
