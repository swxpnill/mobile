import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const APP_ROLE = 'tonnage_app';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(here, '..', '..', 'drizzle');
const RLS_SQL = resolve(here, 'rls.sql');

/** The runtime login from `appUrl`. Only `tonnage_app` is allowed: rls.sql grants to that name. */
function appPassword(appUrl: string): string {
  const url = new URL(appUrl);
  const user = decodeURIComponent(url.username);
  if (user !== APP_ROLE) {
    throw new Error(`DATABASE_URL must log in as ${APP_ROLE}, not ${user || '(none)'}`);
  }
  const password = decodeURIComponent(url.password);
  if (!password) throw new Error(`DATABASE_URL must carry a password for ${APP_ROLE}`);
  return password;
}

/**
 * Applies the drizzle migrations (tracked in `drizzle.__drizzle_migrations`), then `rls.sql`: the
 * `tonnage_app` role with the password from `appUrl`, its grants, RLS policies and the sign-in
 * lookup. Connects as the migration role (the table owner). Safe to run repeatedly.
 */
export async function migrate(migrationUrl: string, appUrl: string): Promise<void> {
  const password = appPassword(appUrl);
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await drizzleMigrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    await client.query('begin');
    try {
      // Bound parameter, read by rls.sql via current_setting and quoted there with format('%L').
      await client.query(`select set_config('tonnage.app_password', $1, true)`, [password]);
      await client.query(readFileSync(RLS_SQL, 'utf8'));
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  } finally {
    await client.end();
  }
}
