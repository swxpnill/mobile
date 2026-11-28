import { type Order, SAMPLE_WORLD, type SyncResponse, type TasksPage, type Truck } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerFor, closeTestApps } from './helpers.ts';
import { waitForLockWaiters, withLockHolder } from './support/lockWait.ts';
import { canvasOrder, createMasters, type Masters } from './support/masters.ts';
import { buildParity, type Parity, type Side } from './support/parity.ts';

afterEach(closeTestApps);

// The API alone: the mock has no concurrency (B3 Review Focus 2 and 3).
let p: Parity;
let api: Side;
let masters: Masters;
let order: Order;
let truck: Truck;
const DEVICE = 'device-ravi-0001';
const aip = () => order.subOrders[0]!;

const events = (e: { atGate: string; tare: string; gross: string }) => {
  const at = new Date(p.clock.now()).toISOString();
  return [
    { eventId: e.atGate, truckId: truck.id, deviceSeq: 1, capturedAtDevice: at, type: 'AT_GATE' },
    { eventId: e.tare, truckId: truck.id, deviceSeq: 2, capturedAtDevice: at, type: 'TARE', tareKg: 12_000 },
    {
      eventId: e.gross,
      truckId: truck.id,
      deviceSeq: 3,
      capturedAtDevice: at,
      type: 'GROSS',
      grossKg: 17_000,
      allocations: [{ orderLineId: aip().lines[0]!.id, netKg: 5_000 }],
    },
  ];
};
const ids = () => ({ atGate: uuidv7(), tare: uuidv7(), gross: uuidv7() });

const count = async (table: string) =>
  (await p.t.ownerDb.$client.query<{ n: number }>(`select count(*)::int as n from ${table} where truck_id = $1`, [truck.id])).rows[0]!.n;

beforeEach(async () => {
  p = await buildParity();
  api = p.api;
  masters = await createMasters(api);
  const res = await api.call('POST', '/v1/orders', { body: canvasOrder(masters) });
  expect(res.status).toBe(201);
  order = res.body as Order;
  const t = await api.call('POST', `/v1/sub-orders/${aip().id}/trucks`, {
    body: {
      vehicleNo: 'CG 04 MK 2291',
      transporterId: masters.transporter.id,
      driverName: 'Mahesh',
      driverPhone: '9425210877',
      lrNo: '',
      plan: [{ orderLineId: aip().lines[0]!.id, plannedKg: 5_000 }],
    },
  });
  expect(t.status).toBe(201);
  truck = t.body as Truck;
  p.clock.advance(60_000);
});

describe('the pull fence (B3 Review Focus 2)', () => {
  it('a pull during a slow approval waits for it; its cursor never skips the approval', async () => {
    const sync = await api.call('POST', '/v1/weighments/sync', { as: 'ravi', body: { deviceId: DEVICE, events: events(ids()) } });
    expect(sync.status).toBe(200);
    const before = (await api.call('GET', '/v1/supervisor/tasks', { as: 'ravi' })).body as TasksPage;
    p.clock.advance(60_000);

    const [approved, pulled] = await withLockHolder(p.t.ownerDb, async (holder, track) => {
      // The approval bumps the change clock, then waits here to write the earning.
      await holder.query('lock table broker_ledger in exclusive mode');
      const approval = track(api.call('POST', `/v1/trucks/${truck.id}/approve`, { body: { version: 4 } }));
      await waitForLockWaiters(p.t.ownerDb, 1);
      // The pull reads the change clock for share: it waits for the approval to commit.
      const pull = track(api.call('GET', `/v1/supervisor/tasks?cursor=${encodeURIComponent(before.cursor)}`, { as: 'ravi' }));
      await waitForLockWaiters(p.t.ownerDb, 2);
      await holder.query('commit');
      return Promise.all([approval, pull]);
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(pulled.status).toBe(200);
    const page = pulled.body as TasksPage;
    // Weighed was already removed; the approval (a later change) is in this page.
    expect(page.removed).toContain(truck.id);
    const written = await p.t.ownerDb.$client.query<{ at: Date }>('select updated_at as at from trucks where id = $1', [truck.id]);
    expect(Date.parse(page.cursor)).toBeGreaterThanOrEqual(written.rows[0]!.at.getTime());
    // And again with the returned cursor: at least once, never skipped.
    const next = (await api.call('GET', `/v1/supervisor/tasks?cursor=${encodeURIComponent(page.cursor)}`, { as: 'ravi' })).body as TasksPage;
    expect(next.removed).toContain(truck.id);
  });
});

describe('the same sync twice at once (B3 Review Focus 3)', () => {
  const race = async (keys: [string, string]) => {
    const e = ids();
    const auth = await bearerFor(p.t, SAMPLE_WORLD.tenant.id, SAMPLE_WORLD.ids.users.ravi);
    return withLockHolder(p.t.ownerDb, async (holder, track) => {
      // Every event locks the order tree first: both requests queue behind the holder.
      await holder.query('select id from orders where id = $1 for update', [order.id]);
      const send = (key: string) =>
        track(p.t.app.inject({
          method: 'POST',
          url: '/v1/weighments/sync',
          headers: { ...auth, 'idempotency-key': key },
          payload: { deviceId: DEVICE, events: events(e) },
        }));
      const one = send(keys[0]);
      const two = send(keys[1]);
      await waitForLockWaiters(p.t.ownerDb, 2);
      await holder.query('commit');
      return Promise.all([one, two]);
    });
  };

  it('one Idempotency-Key: one applies, the other replays its answer', async () => {
    const key = uuidv7();
    const [a, b] = await race([key, key]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const replays = [a, b].filter((r) => r.headers['idempotent-replay'] === 'true');
    expect(replays).toHaveLength(1);
    expect(b.json()).toEqual(a.json());
    expect(await count('weighments')).toBe(2);
    expect(await count('sync_events')).toBe(3);
  });

  it('two keys: each event is applied once, the other request answers duplicate', async () => {
    const [a, b] = await race([uuidv7(), uuidv7()]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const statuses = [a, b].map((r) => (r.json() as SyncResponse).results.map((x) => x.status));
    for (let i = 0; i < 3; i++) expect([statuses[0]![i], statuses[1]![i]].sort()).toEqual(['accepted', 'duplicate']);
    expect(await count('weighments')).toBe(2);
    expect(await count('sync_events')).toBe(3);
    const t = (await api.call('GET', `/v1/trucks/${truck.id}`)).body as Truck;
    expect(t.state).toBe('weighed');
  });
});
