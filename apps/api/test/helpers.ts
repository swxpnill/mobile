import { createFakeClock } from '@tonnage/mock-api';
import type { Role } from '@tonnage/shared';
import type { FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { inject } from 'vitest';
import type { Clock } from '../src/clock.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { companies, tenants, users } from '../src/db/schema/index.ts';
import { loadEnv, type Env } from '../src/env.ts';
import type { OtpProvider } from '../src/auth/otp-provider.ts';
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
  /** Closes the app and both pools. */
  close(): Promise<void>;
}

const open: TestApp[] = [];

export async function buildTestApp(
  opts: { clock?: Clock; env?: NodeJS.ProcessEnv; otp?: OtpProvider; logStream?: DestinationStream } = {},
): Promise<TestApp> {
  const clock = opts.clock ?? createFakeClock(TEST_NOW);
  const runtime = createDb(inject('appDatabaseUrl'));
  const owner = createDb(inject('ownerDatabaseUrl'));
  const app = await buildApp({
    env: testEnv(opts.env),
    db: runtime.db,
    clock,
    ...(opts.otp ? { otp: opts.otp } : {}),
    ...(opts.logStream ? { logStream: opts.logStream } : {}),
  });
  const testApp: TestApp = {
    app,
    db: runtime.db,
    ownerDb: owner.db,
    clock,
    async reset() {
      // Drizzle's migration bookkeeping lives in schema `drizzle`, so it is never truncated here.
      const tables = await owner.db.$client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      if (tables.rows.length === 0) return;
      const list = tables.rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      await owner.db.$client.query(`truncate ${list} restart identity cascade`);
    },
    async close() {
      await app.close();
      await runtime.close();
      await owner.close();
    },
  };
  open.push(testApp);
  return testApp;
}

/** Closes every app and pool a test opened. Call from `afterEach`/`afterAll`. */
export async function closeTestApps(): Promise<void> {
  for (const t of open.splice(0)) await t.close();
}

const seededAt = new Date(TEST_NOW);
const stamps = { createdAt: seededAt, updatedAt: seededAt };

/** Inserts a tenant through the owner connection (bypassing RLS); returns its id. */
export async function ownerInsertTenant(ownerDb: Db, name: string): Promise<string> {
  const id = uuidv7();
  await ownerDb.insert(tenants).values({ id, name, settings: {}, ...stamps });
  return id;
}

/** Inserts a company through the owner connection; returns its id. */
export async function ownerInsertCompany(
  ownerDb: Db,
  tenantId: string,
  code: string,
): Promise<string> {
  const id = uuidv7();
  await ownerDb
    .insert(companies)
    .values({ id, tenantId, code, name: `${code} Ltd`, orderPrefix: code, ...stamps });
  return id;
}

/** Inserts a user through the owner connection; returns its id. */
export async function ownerInsertUser(
  ownerDb: Db,
  tenantId: string,
  user: { mobile: string; name: string; role?: Role; active?: boolean },
): Promise<string> {
  const id = uuidv7();
  await ownerDb.insert(users).values({
    id,
    tenantId,
    name: user.name,
    mobile: user.mobile,
    role: user.role ?? 'owner',
    active: user.active ?? true,
    invitedAt: seededAt,
    ...stamps,
  });
  return id;
}
