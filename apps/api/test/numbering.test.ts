import { createFakeClock } from '@tonnage/mock-api';
import { SAMPLE_WORLD, type Order } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client.ts';
import { seed } from '../src/db/seed.ts';
import { nextNumber } from '../src/services/numbering.ts';
import { bearerFor, buildTestApp, closeTestApps, TEST_NOW, type TestApp } from './helpers.ts';
import { createMasters, krmOrder, type Masters } from './support/masters.ts';
import type { Side } from './support/parity.ts';
import { fastifyTransport } from './fastify-transport.ts';
import { waitForLockWaiters } from './support/lockWait.ts';

afterEach(closeTestApps);

const TENANT = SAMPLE_WORLD.tenant.id;
const RAJESH = SAMPLE_WORLD.ids.users.rajesh;

let t: TestApp;
let clock: ReturnType<typeof createFakeClock>;
let masters: Masters;
let owner: Record<string, string>;

/** The API as a parity `Side`, so the shared master builders work against it alone. */
const apiSide = (): Side => {
  const transport = fastifyTransport(t.app);
  return {
    name: 'api',
    call: async (method, path, opts = {}) => {
      const res = await transport.request({
        method,
        path,
        headers: { ...owner, 'content-type': 'application/json', 'idempotency-key': uuidv7() },
        body: opts.body,
      });
      return { status: res.status, body: res.body };
    },
    addTruck: () => Promise.reject(new Error('not used')),
  };
};

beforeEach(async () => {
  clock = createFakeClock(TEST_NOW);
  t = await buildTestApp({ clock });
  await t.reset();
  await seed(t.ownerDb, clock);
  owner = await bearerFor(t, TENANT, RAJESH);
  masters = await createMasters(apiSide());
});

const book = () =>
  t.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...owner, 'idempotency-key': uuidv7() },
    payload: krmOrder(masters),
  });

const numberOf = (res: { statusCode: number; body: string; json<T>(): T }) => {
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Order>().number;
};

const seq = (from: number, to: number, prefix: string) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(4, '0')}`);

describe('numbering (Ruling 5)', () => {
  it('nextNumber: 1, 2, 3 in a series; another series and another FY start at 1; a rolled-back take is never a duplicate', async () => {
    const take = (key: string, fy: string) =>
      withTenant(t.db, TENANT, (tx) => nextNumber(tx, key, fy, clock.now()));
    expect([await take('order', '2026-27'), await take('order', '2026-27'), await take('order', '2026-27')]).toEqual([1, 2, 3]);
    expect(await take('slip', '2026-27')).toBe(1);
    expect(await take('order', '2027-28')).toBe(1);
    await expect(
      withTenant(t.db, TENANT, async (tx) => {
        await nextNumber(tx, 'order', '2026-27', clock.now());
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    // The bump rolled back with the transaction and with whatever it numbered, so 4 goes to the
    // next caller: nothing that used it survived.
    expect(await take('order', '2026-27')).toBe(4);
  });

  it('Review Focus 1: fifty creates at once on a pool of 10 → fifty distinct consecutive numbers', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => book()));
    const numbers = results.map(numberOf).sort();
    expect(numbers).toEqual(seq(1, 50, 'SO-2611-'));
  });

  it('Review Focus 1, staged: fifty creates queued behind a held series row lock → 1..50 once each', async () => {
    // The series row exists (an earlier order), and a separate connection holds its lock.
    expect(numberOf(await book())).toBe('SO-2611-0001');
    const holder = await t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from number_series where tenant_id = $1 for update`, [TENANT]);
      const pending = Promise.all(Array.from({ length: 50 }, () => book()));
      // The runtime pool has 10 connections: ten requests reach the upsert and wait on the lock.
      await waitForLockWaiters(t.ownerDb, 10);
      await holder.query('commit');
      const numbers = (await pending).map(numberOf).sort();
      expect(numbers).toEqual(seq(2, 51, 'SO-2611-'));
    } finally {
      holder.release();
    }
  });

  it('the IST financial-year boundary: 2027-03-31T18:29:59Z is FY 2026-27 (2703), 18:30:00Z starts 2027-28 at 0001 (2704)', async () => {
    clock.advance(Date.parse('2027-03-31T18:29:59Z') - clock.now());
    owner = await bearerFor(t, TENANT, RAJESH);
    expect(numberOf(await book())).toBe('SO-2703-0001');
    expect(numberOf(await book())).toBe('SO-2703-0002');
    clock.advance(1_000);
    owner = await bearerFor(t, TENANT, RAJESH);
    expect(numberOf(await book())).toBe('SO-2704-0001');
    const rows = await t.ownerDb.$client.query<{ fy: string; next_value: string }>(
      `select fy, next_value from number_series where series_key = 'order' order by fy`,
    );
    expect(rows.rows.map((r) => [r.fy, Number(r.next_value)])).toEqual([
      ['2026-27', 3],
      ['2027-28', 2],
    ]);
  });
});
