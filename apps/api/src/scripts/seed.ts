import { existsSync } from 'node:fs';
import { systemClock } from '../clock.ts';
import { createDb } from '../db/client.ts';
import { seed } from '../db/seed.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) {
  console.error('MIGRATION_DATABASE_URL must be set (the seed needs the schema owner connection).');
  process.exit(1);
}

const { db, close } = createDb(migrationUrl);
try {
  const { tenantId } = await seed(db, systemClock);
  console.log(`Seeded tenant ${tenantId}.`);
} finally {
  await close();
}
