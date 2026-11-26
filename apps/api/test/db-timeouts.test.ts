import { createFakeClock } from '@tonnage/mock-api';
import { ERROR_MESSAGES, SAMPLE_WORLD } from '@tonnage/shared';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client.ts';
import { seed } from '../src/db/seed.ts';
import { loadEnv } from '../src/env.ts';
import { bearerFor, buildTestApp, closeTestApps, TEST_NOW, testEnv } from './helpers.ts';
import { waitForLockWaiters, withLockHolder } from './support/lockWait.ts';

afterEach(closeTestApps);

const TENANT = SAMPLE_WORLD.tenant.id;
const RAJESH = SAMPLE_WORLD.ids.users.rajesh;

describe('database timeouts: config', () => {
  it('defaults to a 5 s lock timeout and a 15 s statement timeout; refuses anything but a positive whole number', () => {
    expect(testEnv()).toMatchObject({ DB_LOCK_TIMEOUT_MS: 5_000, DB_STATEMENT_TIMEOUT_MS: 15_000 });
    expect(testEnv({ DB_LOCK_TIMEOUT_MS: '250' }).DB_LOCK_TIMEOUT_MS).toBe(250);
    const raw = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'x', MIGRATION_DATABASE_URL: 'x', JWT_SECRET: 'a'.repeat(32) };
    expect(() => loadEnv({ ...raw, DB_LOCK_TIMEOUT_MS: '0' })).toThrow(/DB_LOCK_TIMEOUT_MS/);
    expect(() => loadEnv({ ...raw, DB_STATEMENT_TIMEOUT_MS: 'soon' })).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
  });

  it('every tenant transaction sets both timeouts transaction-locally; the pooled session keeps its own', async () => {
    const t = await buildTestApp({ env: { DB_LOCK_TIMEOUT_MS: '300', DB_STATEMENT_TIMEOUT_MS: '2000' } });
    const seen = await withTenant(t.db, TENANT, (tx) =>
      tx.execute<{ lock: string; stmt: string }>(
        sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`,
      ),
    );
    expect(seen.rows[0]).toEqual({ lock: '300ms', stmt: '2s' });
    const session = await t.db.$client.query<{ lock: string; stmt: string }>(
      `select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as stmt`,
    );
    expect(session.rows[0]).toEqual({ lock: '0', stmt: '0' });
  });
});

describe('database timeouts: a request that waits too long on a lock', () => {
  it('a held lock and a 300 ms lock timeout → 503 BUSY with Retry-After well within the statement timeout; no pg text', async () => {
    const clock = createFakeClock(TEST_NOW);
    const t = await buildTestApp({ clock, env: { DB_LOCK_TIMEOUT_MS: '300', DB_STATEMENT_TIMEOUT_MS: '10000' } });
    await t.reset();
    await seed(t.ownerDb, clock);
    const owner = await bearerFor(t, TENANT, RAJESH);
    const patch = () =>
      t.app.inject({ method: 'PATCH', url: '/v1/settings', headers: owner, payload: { agedOrderDays: 12 } });

    await withLockHolder(t.ownerDb, async (holder, track) => {
      await holder.query(`select 1 from tenants where id = $1 for update`, [TENANT]);
      const started = Date.now();
      const pending = track(patch());
      await waitForLockWaiters(t.ownerDb, 1);
      const res = await pending;
      const ms = Date.now() - started;
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toEqual({ code: 'BUSY', message: ERROR_MESSAGES.BUSY });
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).not.toMatch(/lock|timeout|canceling/i);
      expect(ms).toBeLessThan(5_000);
      await holder.query('rollback');
    });
    // The lock is gone: the same change goes through.
    const ok = await patch();
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('database contention errors', () => {
  it('deadlock (40P01), serialization failure (40001) and lock not available (55P03) → 503 BUSY with Retry-After; other pg errors stay 500', async () => {
    const t = await buildTestApp();
    // As drizzle throws them: its own error with the driver's error as `cause`.
    const pgFailure = (code: string) =>
      Object.assign(new Error('Failed query: update orders ...'), {
        cause: Object.assign(new Error(`${code}: deadlock detected, process 4242 waits for ShareLock`), { code, severity: 'ERROR' }),
      });
    for (const code of ['40P01', '40001', '55P03', '23502']) {
      t.app.get(`/_t/pg-${code}`, async () => {
        throw pgFailure(code);
      });
    }
    await t.app.ready();
    for (const code of ['40P01', '40001', '55P03']) {
      const res = await t.app.inject({ method: 'GET', url: `/_t/pg-${code}` });
      expect(res.statusCode, code).toBe(503);
      expect(res.json()).toEqual({ code: 'BUSY', message: ERROR_MESSAGES.BUSY });
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).not.toMatch(/deadlock|ShareLock|4242/);
    }
    const other = await t.app.inject({ method: 'GET', url: '/_t/pg-23502' });
    expect(other.statusCode).toBe(500);
    expect(other.json()).toEqual({ code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL });
  });
});
