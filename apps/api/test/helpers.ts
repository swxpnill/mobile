import { createFakeClock } from '@tonnage/mock-api';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import type { Clock } from '../src/clock.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { loadEnv, type Env } from '../src/env.ts';
import { buildApp } from '../src/server.ts';

/** 2026-11-03T04:30:00Z, the instant the contract examples use. */
export const TEST_NOW = Date.parse('2026-11-03T04:30:00.000Z');

export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    MIGRATION_DATABASE_URL: inject('ownerDatabaseUrl'),
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
    RATE_LIMIT: 'off',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export interface TestApp {
  app: FastifyInstance;
  /** The runtime connection (role `tonnage_app`). */
  db: Db;
  /** Owner connection, for set-up and assertions that bypass RLS. */
  ownerDb: Db;
  clock: Clock;
  /** Empties every table (owner connection, restart identity, cascade). */
  reset(): Promise<void>;
}

const open: TestApp[] = [];

export async function buildTestApp(opts: { clock?: Clock; env?: NodeJS.ProcessEnv } = {}): Promise<TestApp> {
  const clock = opts.clock ?? createFakeClock(TEST_NOW);
  const db = createDb(inject('appDatabaseUrl'));
  const ownerDb = createDb(inject('ownerDatabaseUrl'));
  const app = await buildApp({ env: testEnv(opts.env), db, clock });
  const testApp: TestApp = {
    app,
    db,
    ownerDb,
    clock,
    async reset() {
      const tables = await ownerDb.$client.query<{ tablename: string }>(
        `select tablename from pg_tables
         where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
      );
      if (tables.rows.length === 0) return;
      const list = tables.rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      await ownerDb.$client.query(`truncate ${list} restart identity cascade`);
    },
  };
  open.push(testApp);
  return testApp;
}

/** Closes every app and pool a test opened. Call from `afterEach`/`afterAll`. */
export async function closeTestApps(): Promise<void> {
  for (const t of open.splice(0)) {
    await t.app.close();
    await t.db.$client.end();
    await t.ownerDb.$client.end();
  }
}
