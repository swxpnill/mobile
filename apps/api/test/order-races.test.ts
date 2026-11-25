import { SAMPLE_WORLD, type Order } from '@tonnage/shared';
import { createFakeClock } from '@tonnage/mock-api';
import type { LightMyRequestResponse } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../src/db/seed.ts';
import { bearerFor, buildTestApp, closeTestApps, TEST_NOW, type TestApp } from './helpers.ts';
import { waitForLockWaiters } from './support/lockWait.ts';
import { COMPANY, addressId, canvasOrder, createMasters, krmOrder, type Masters } from './support/masters.ts';
import { apiSide } from './support/parity.ts';

afterEach(closeTestApps);

let t: TestApp;
let owner: Record<string, string>;
let masters: Masters;

beforeEach(async () => {
  const clock = createFakeClock(TEST_NOW);
  t = await buildTestApp({ clock });
  await t.reset();
  await seed(t.ownerDb, clock);
  owner = await bearerFor(t, SAMPLE_WORLD.tenant.id, SAMPLE_WORLD.ids.users.rajesh);
  masters = await createMasters(apiSide(t, () => owner));
});

const book = (body: object) =>
  t.app.inject({ method: 'POST', url: '/v1/orders', headers: { ...owner, 'idempotency-key': uuidv7() }, payload: body });
const deactivate = (companyId: string) =>
  t.app.inject({ method: 'PATCH', url: `/v1/companies/${companyId}`, headers: owner, payload: { version: 1, active: false } });
const codeOf = (r: LightMyRequestResponse) => [r.statusCode, r.statusCode < 300 ? null : r.json<{ code: string }>().code];
const count = async (table: string) =>
  (await t.ownerDb.$client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n;

/**
 * Holds a lock on a separate connection while `steps` start requests one by one, each waiting
 * until it queues behind the lock (so their order of arrival is fixed), then lets go.
 */
async function staged(lockSql: string, params: unknown[], steps: (() => Promise<LightMyRequestResponse>)[]) {
  const holder = await t.ownerDb.$client.connect();
  try {
    await holder.query('begin');
    await holder.query(lockSql, params);
    const pending: Promise<LightMyRequestResponse>[] = [];
    for (const [i, step] of steps.entries()) {
      pending.push(step());
      await waitForLockWaiters(t.ownerDb, i + 1);
    }
    await holder.query('commit');
    return await Promise.all(pending);
  } finally {
    holder.release();
  }
}

const LOCK_COMPANY = 'select 1 from companies where id = $1 for update';

describe('company deactivation against an order create on the same company', () => {
  it('deactivation first: the create then sees the company inactive → 409 COMPANY_INACTIVE; no order', async () => {
    const [patch, create] = await staged(LOCK_COMPANY, [COMPANY.KRM], [() => deactivate(COMPANY.KRM), () => book(krmOrder(masters))]);
    expect([codeOf(patch!), codeOf(create!)]).toEqual([
      [200, null],
      [409, 'COMPANY_INACTIVE'],
    ]);
    expect(await count('orders')).toBe(0);
  });

  it('create first: the deactivation waits for it, then counts its sub-order → 409 COMPANY_HAS_OPEN_ORDERS', async () => {
    const [create, patch] = await staged(LOCK_COMPANY, [COMPANY.KRM], [() => book(krmOrder(masters)), () => deactivate(COMPANY.KRM)]);
    expect(codeOf(create!)).toEqual([201, null]);
    expect(codeOf(patch!)).toEqual([409, 'COMPANY_HAS_OPEN_ORDERS']);
    expect(patch!.json().details).toEqual({ openSubOrders: 1 });
    const [krm] = (await t.ownerDb.$client.query<{ active: boolean }>('select active from companies where id = $1', [COMPANY.KRM])).rows;
    expect(krm?.active).toBe(true);
  });
});

describe('a reference removed while the create waits on it → the 422 the checks give, not a 500', () => {
  it('the ship-to site deleted (committed while the order insert waited on it) → 422 at shipToId; nothing written', async () => {
    const hingna = addressId(masters.shubham, 'Hingna MIDC site');
    const [res] = await staged('delete from party_addresses where id = $1', [hingna], [() => book(canvasOrder(masters))]);
    expect(res!.statusCode, res!.body).toBe(422);
    expect(res!.json()).toEqual({
      code: 'VALIDATION',
      message: expect.any(String),
      details: [{ path: ['shipToId'], message: "Choose one of the customer's sites" }],
    });
    expect(await count('orders')).toBe(0);
    expect(await count('order_lines')).toBe(0);
  });

  it('a product deleted (committed while the line insert waited on it) → 422 at each of its lines; nothing written', async () => {
    const id = masters.tmt16.id;
    const [res] = await staged(
      'with links as (delete from product_companies where product_id = $1) delete from products where id = $1',
      [id],
      [() => book(canvasOrder(masters))],
    );
    expect(res!.statusCode, res!.body).toBe(422);
    expect(res!.json().details).toEqual([
      { path: ['subOrders', 0, 'lines', 2, 'productId'], message: 'Unknown product' },
      { path: ['subOrders', 1, 'lines', 0, 'productId'], message: 'Unknown product' },
    ]);
    expect(await count('orders')).toBe(0);
    // The refused create used up no number.
    const next = await book(krmOrder(masters));
    expect(next.json<Order>().number).toBe('SO-2611-0001');
  });
});
