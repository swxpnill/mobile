import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startEmbedded, withDatabase } from './embedded.ts';

const DEV_DB = 'tonnage_dev';
const APP_ROLE = { user: 'tonnage_app', password: 'tonnage_app' };

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cluster = await startEmbedded({ dataDir: resolve(apiRoot, '.pgdata'), port: 54328 });

const admin = new pg.Client({ connectionString: cluster.adminUrl });
await admin.connect();
try {
  const exists = await admin.query('select 1 from pg_database where datname = $1', [DEV_DB]);
  if (exists.rowCount === 0) await admin.query(`create database ${DEV_DB}`);
} finally {
  await admin.end();
}

console.log('Embedded PostgreSQL is running. Put these in apps/api/.env, then run db:migrate:');
console.log(`DATABASE_URL=${withDatabase(cluster.adminUrl, DEV_DB, APP_ROLE)}`);
console.log(`MIGRATION_DATABASE_URL=${withDatabase(cluster.adminUrl, DEV_DB)}`);

async function stop(): Promise<void> {
  await cluster.stop();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
