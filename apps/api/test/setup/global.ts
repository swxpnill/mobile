import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { startEmbedded, withDatabase, type EmbeddedCluster } from '../../src/scripts/embedded.ts';

const TEST_DB = 'tonnage_test';
const APP_ROLE = { user: 'tonnage_app', password: 'tonnage_app' };

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner (superuser) connection to the test database: migrations, truncation, assertions. */
    ownerDatabaseUrl: string;
    /** Runtime connection as `tonnage_app`: what the API itself uses. */
    appDatabaseUrl: string;
  }
}

/**
 * Starts a local PostgreSQL (or uses `TEST_DATABASE_ADMIN_URL` in CI), recreates the test database
 * and the runtime role. From Task 2 on it also migrates.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let cluster: EmbeddedCluster | undefined;
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    cluster = await startEmbedded({ dataDir: resolve(apiRoot, '.pgdata-test'), port: 54329 });
    adminUrl = cluster.adminUrl;
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${TEST_DB} with (force)`);
    await admin.query(`create database ${TEST_DB}`);
    const role = await admin.query('select 1 from pg_roles where rolname = $1', [APP_ROLE.user]);
    if (role.rowCount === 0) {
      await admin.query(`create role ${APP_ROLE.user} login password '${APP_ROLE.password}'`);
    }
  } finally {
    await admin.end();
  }

  project.provide('ownerDatabaseUrl', withDatabase(adminUrl, TEST_DB));
  project.provide('appDatabaseUrl', withDatabase(adminUrl, TEST_DB, APP_ROLE));

  return async () => {
    await cluster?.stop();
  };
}
