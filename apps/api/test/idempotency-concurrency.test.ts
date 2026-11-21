import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokens } from '../src/auth/tokens.ts';
import { companies } from '../src/db/schema/index.ts';
import { AppError } from '../src/http/errors.ts';
import { defineRoute } from '../src/http/route.ts';
import {
  buildTestApp,
  closeTestApps,
  ownerInsertTenant,
  ownerInsertUser,
  testEnv,
  type TestApp,
} from './helpers.ts';

afterEach(closeTestApps);

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Resolves once some backend is waiting on a lock while inserting an idempotency key. */
async function untilSecondInsertBlocks(t: TestApp): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    const { rows } = await t.ownerDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike '%insert into "idempotency_keys"%'`);
    if ((rows[0]?.n ?? 0) > 0) return;
  }
  throw new Error('the second request never blocked on the idempotency key');
}

describe('idempotency under concurrency', () => {
  let t: TestApp;
  let headers: Record<string, string>;
  let runs: number;
  let firstRun: ReturnType<typeof gate>;
  let failFirst: boolean;

  beforeEach(async () => {
    t = await buildTestApp();
    await t.reset();
    const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
    const ownerId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '9826100012', name: 'Rajesh Agrawal' });
    const { token } = await createTokens(testEnv().JWT_SECRET).issueAccess(
      { id: ownerId, tenantId },
      uuidv7(),
      t.clock.now(),
    );
    headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'same-key' };
    runs = 0;
    firstRun = gate();
    failFirst = false;
    defineRoute(t.app, 'POST', '/v1/test/slow-create', {
      action: 'companies.manage',
      idempotent: true,
      handler: async (ctx) => {
        runs += 1;
        const run = runs;
        if (run === 1) await firstRun.wait;
        await ctx.tx.insert(companies).values({
          id: uuidv7(),
          tenantId: ctx.user.tenantId,
          code: `C${run}`,
          name: `Company ${run}`,
          orderPrefix: `C${run}`,
          createdAt: new Date(ctx.now),
          updatedAt: new Date(ctx.now),
        });
        if (run === 1 && failFirst) throw new AppError(409, 'STALE');
        return { status: 201, body: { run } };
      },
    });
  });

  const send = () => t.app.inject({ method: 'POST', url: '/v1/test/slow-create', headers });

  it('Review Focus 5: two concurrent same-key POSTs → one handler run; other is 409 IDEMPOTENCY_IN_PROGRESS or the replay', async () => {
    const a = send();
    const b = send();
    await untilSecondInsertBlocks(t);
    firstRun.open();
    const [ra, rb] = await Promise.all([a, b]);

    expect(runs).toBe(1);
    const [won, other] = ra.headers['idempotent-replay'] === undefined ? [ra, rb] : [rb, ra];
    expect(won.statusCode).toBe(201);
    expect(won.json()).toEqual({ run: 1 });
    if (other.statusCode === 409) {
      expect(other.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');
    } else {
      expect(other.statusCode).toBe(201);
      expect(other.headers['idempotent-replay']).toBe('true');
      expect(other.json()).toEqual({ run: 1 });
    }
    expect(await t.ownerDb.select().from(companies)).toHaveLength(1);
  });

  it('when the first rolls back, the waiting second claims the key and runs its handler', async () => {
    failFirst = true;
    const a = send();
    const b = send();
    await untilSecondInsertBlocks(t);
    firstRun.open();
    const [ra, rb] = await Promise.all([a, b]);

    expect(runs).toBe(2);
    const statuses = [ra.statusCode, rb.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const ok = ra.statusCode === 201 ? ra : rb;
    expect(ok.json()).toEqual({ run: 2 });
    expect(ok.headers['idempotent-replay']).toBeUndefined();
    const rows = await t.ownerDb.select({ code: companies.code }).from(companies);
    expect(rows).toEqual([{ code: 'C2' }]);
  });
});
