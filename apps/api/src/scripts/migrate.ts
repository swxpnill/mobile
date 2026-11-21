import { existsSync } from 'node:fs';
import { migrate } from '../db/migrate.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!migrationUrl || !appUrl) {
  console.error(
    'MIGRATION_DATABASE_URL and DATABASE_URL must be set (see `pnpm --filter @tonnage/api db:dev`).',
  );
  process.exit(1);
}

await migrate(migrationUrl, appUrl);
console.log('Migrated.');
