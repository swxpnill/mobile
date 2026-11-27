import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/http/errors.ts';
import { defineRoute } from '../src/http/route.ts';
import { bearerFor, buildTestApp, closeTestApps, ownerInsertTenant, ownerInsertUser, type TestApp } from './helpers.ts';
import { gate } from './support/gate.ts';
import { waitForLockWaiters } from './support/lockWait.ts';

afterEach(async () => {
  const t = await buildTestApp();
  await t.ownerDb.$client.query('drop schema if exists evt_test cascade');
  await closeTestApps();
});

/**
 * A scratch table the events write to, in a schema of its own (never `public`, which other tests
 * enumerate), dropped after each test.
 */
async function scratch(t: TestApp): Promise<void> {
  const q = (s: string) => t.ownerDb.$client.query(s);
  await q(`drop schema if exists evt_test cascade`);
  await q(`create schema evt_test`);
  await q(`grant usage on schema evt_test to tonnage_app`);
  await q(`create table evt_test.scratch (tenant_id uuid not null, n int not null)`);
  await q(`grant select, insert on evt_test.scratch to tonnage_app`);
}

const rows = async (t: TestApp) =>
  (await t.ownerDb.$client.query<{ n: number }>('select n from evt_test.scratch order by n')).rows.map((r) => r.n);

describe('per-event transactions (B3 Ruling 4)', () => {
  let t: TestApp;
  let owner: Record<string, string>;

  beforeEach(async () => {
    t = await buildTestApp();
    await t.reset();
    await scratch(t);
    const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
    const ownerId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '9826100012', name: 'Rajesh Agrawal' });
    owner = await bearerFor(t, tenantId, ownerId);
  });

  const post = (url: string, key: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: { ...owner, 'idempotency-key': key }, payload });

  it('each event commits on its own: a later failing event does not undo an earlier one', async () => {
    defineRoute(t.app, 'POST', '/v1/test/events', {
      action: 'companies.manage',
      idempotent: true,
      eventTransactions: true,
      body: z.object({ ns: z.array(z.number().int()) }),
      async handler(ctx) {
        const results: string[] = [];
        for (const n of ctx.body.ns) {
          try {
            await ctx.inOwnTransaction(async (tx) => {
              await tx.execute(sql`insert into evt_test.scratch (tenant_id, n) values (${ctx.user.tenantId}, ${n})`);
              if (n < 0) throw new AppError(422, 'VALIDATION');
            });
            results.push('ok');
          } catch {
            results.push('failed');
          }
        }
        return { body: { results } };
      },
    });
    const res = await post('/v1/test/events', 'key-events-0001', { ns: [1, -2, 3] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: ['ok', 'failed', 'ok'] });
    expect(await rows(t)).toEqual([1, 3]);
  });

  it('a failure of the request after its events leaves the events committed', async () => {
    defineRoute(t.app, 'POST', '/v1/test/events-then-fail', {
      action: 'companies.manage',
      idempotent: true,
      eventTransactions: true,
      async handler(ctx) {
        await ctx.inOwnTransaction((tx) =>
          tx.execute(sql`insert into evt_test.scratch (tenant_id, n) values (${ctx.user.tenantId}, 7)`),
        );
        throw new AppError(409, 'STALE');
      },
    });
    const res = await post('/v1/test/events-then-fail', 'key-events-0002', {});
    expect(res.statusCode).toBe(409);
    expect(await rows(t)).toEqual([7]);
  });

  it('the same Idempotency-Key at once: the second waits for the first and replays its answer', async () => {
    const hold = gate();
    let runs = 0;
    defineRoute(t.app, 'POST', '/v1/test/events-slow', {
      action: 'companies.manage',
      idempotent: true,
      eventTransactions: true,
      async handler(ctx) {
        runs += 1;
        await ctx.inOwnTransaction((tx) =>
          tx.execute(sql`insert into evt_test.scratch (tenant_id, n) values (${ctx.user.tenantId}, ${runs})`),
        );
        await hold.wait;
        return { status: 201, body: { id: uuidv7() } };
      },
    });
    const first = post('/v1/test/events-slow', 'key-events-0003', {});
    // The first holds its claim; the second queues behind it on the idempotency row.
    await new Promise((r) => setTimeout(r, 100));
    const second = post('/v1/test/events-slow', 'key-events-0003', {});
    await waitForLockWaiters(t.ownerDb, 1);
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(runs).toBe(1);
    expect(await rows(t)).toEqual([1]);
  });

  it('a route without eventTransactions has no inOwnTransaction', async () => {
    let seen: unknown = 'unset';
    defineRoute(t.app, 'POST', '/v1/test/plain', {
      action: 'companies.manage',
      idempotent: true,
      async handler(ctx) {
        seen = (ctx as { inOwnTransaction?: unknown }).inOwnTransaction;
        return {};
      },
    });
    await post('/v1/test/plain', 'key-events-0004', {});
    expect(seen).toBeUndefined();
  });
});
