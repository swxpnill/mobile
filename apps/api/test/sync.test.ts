import { type DoneToday, type Order, SAMPLE_WORLD, type SyncResponse, type TasksPage, type Truck } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { canvasOrder, createMasters, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res, type Side } from './support/parity.ts';

afterEach(closeTestApps);

let p: Parity;
const masters = new Map<Side, Masters>();
const orders = new Map<Side, Order>();
const trucksOf = new Map<Side, Truck[]>();
const m = (s: Side) => masters.get(s)!;
const o = (s: Side) => orders.get(s)!;
const aip = (s: Side) => o(s).subOrders[0]!;
const tId = (s: Side, i = 0) => trucksOf.get(s)![i]!.id;

/**
 * The cursor is the tenant change clock on the API (B3 Ruling 3), the newest change seen on the
 * mock; `changedAt` likewise. Neither is compared exactly: the cursor is checked for never moving back.
 */
const withoutClocks = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'changedAt' || k === 'cursor' ? '(clock)' : x)));

function expectSame([mock, api]: [Res, Res]): void {
  expect(api.status, JSON.stringify(api.body)).toBe(mock.status);
  expect(withoutClocks(normaliseIds(api))).toEqual(withoutClocks(normaliseIds(mock)));
}

const DEVICE = 'device-ravi-0001';
const at = () => new Date(p.clock.now()).toISOString();

const sync = (events: (s: Side) => object[]) =>
  p.both('POST', () => '/v1/weighments/sync', (s) => ({ as: 'ravi', body: { deviceId: DEVICE, events: events(s) } }));

const pull = (cursor?: (s: Side) => string) =>
  p.both(
    'GET',
    (s) => `/v1/supervisor/tasks${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor(s))}`}`,
    () => ({ as: 'ravi' }),
  );

/** Every event of one truck through to weighed, with the plan's two lines in full. */
const ids = () => ({ atGate: uuidv7(), tare: uuidv7(), gross: uuidv7() });
const fullWeigh = (s: Side, truck: number, e: ReturnType<typeof ids>) => [
  { eventId: e.atGate, truckId: tId(s, truck), deviceSeq: 1, capturedAtDevice: at(), type: 'AT_GATE' },
  { eventId: e.tare, truckId: tId(s, truck), deviceSeq: 2, capturedAtDevice: at(), type: 'TARE', tareKg: 12_000 },
  {
    eventId: e.gross,
    truckId: tId(s, truck),
    deviceSeq: 3,
    capturedAtDevice: at(),
    type: 'GROSS',
    grossKg: 12_000 + 5_000,
    allocations: [{ orderLineId: aip(s).lines[0]!.id, netKg: 5_000 }],
  },
];

beforeEach(async () => {
  p = await buildParity();
  masters.clear();
  orders.clear();
  trucksOf.clear();
  for (const side of [p.mock, p.api]) masters.set(side, await createMasters(side));
  for (const side of [p.mock, p.api]) {
    const res = await side.call('POST', '/v1/orders', { body: canvasOrder(m(side)) });
    expect(res.status).toBe(201);
    orders.set(side, res.body as Order);
  }
  for (const vehicleNo of ['CG 04 MK 2291', 'CG 04 LT 6619']) {
    p.clock.advance(1_000);
    for (const side of [p.mock, p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${aip(side).id}/trucks`, {
        body: {
          vehicleNo,
          transporterId: m(side).transporter.id,
          driverName: 'Mahesh',
          driverPhone: '9425210877',
          lrNo: '',
          plan: [{ orderLineId: aip(side).lines[0]!.id, plannedKg: 5_000 }],
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      trucksOf.set(side, [...(trucksOf.get(side) ?? []), res.body as Truck]);
    }
  }
  p.clock.advance(60_000);
});

describe('weighment sync equals the mock (B3 Task 7)', () => {
  it('out of order: a GROSS before its TARE in one request is refused, and the TARE after it is blocked', async () => {
    const e = ids();
    const atGate = (s: Side) => fullWeigh(s, 0, e)[0]!;
    const tare = (s: Side) => fullWeigh(s, 0, e)[1]!;
    const gross = (s: Side) => fullWeigh(s, 0, e)[2]!;
    const res = await sync((s) => [atGate(s), gross(s), tare(s)]);
    expectSame(res);
    expect((res[1].body as SyncResponse).results.map((r) => r.status)).toEqual(['accepted', 'rejected', 'rejected']);
    // Sent again in the right order on a new key: the refusals replay, the truck stays at the gate.
    expectSame(await sync((s) => [tare(s), gross(s)]));
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tId(s)}`));
  });

  it('a deactivated supervisor is 401 and nothing is applied', async () => {
    await p.t.ownerDb.$client.query('update users set active = false where id = $1', [SAMPLE_WORLD.ids.users.ravi]);
    const res = await p.api.call('POST', '/v1/weighments/sync', { as: 'ravi', body: { deviceId: DEVICE, events: fullWeigh(p.api, 0, ids()) } });
    expect(res.status).toBe(401);
    const w = await p.t.ownerDb.$client.query('select count(*)::int as n from weighments');
    expect(w.rows[0].n).toBe(0);
    const ev = await p.t.ownerDb.$client.query('select count(*)::int as n from sync_events');
    expect(ev.rows[0].n).toBe(0);
  });
});

describe('the tasks pull equals the mock (B3 Task 7)', () => {
  it('a full pull lists my open trucks with no removed; the cursor never moves back', async () => {
    const first = await pull();
    expectSame(first);
    const page = first[1].body as TasksPage;
    expect(page.items).toHaveLength(2);
    expect(page.removed).toEqual([]);
    expect(page.serverTime).toBe(at());

    // Nothing changed: an empty page, the same cursor or later.
    const again = await pull((s) => (s === p.api ? page.cursor : (first[0].body as TasksPage).cursor));
    expectSame(again);
    expect((again[1].body as TasksPage).cursor >= page.cursor).toBe(true);
  });

  it('with a cursor: weighed and cancelled trucks come back in removed, an arrival in items', async () => {
    const first = await pull();
    const cursor = (s: Side) => ((s === p.api ? first[1] : first[0]).body as TasksPage).cursor;
    p.clock.advance(60_000);
    // Truck 0 is weighed (awaiting approval, no longer the phone's); truck 1 is cancelled.
    await sync((s) => fullWeigh(s, 0, ids()));
    p.clock.advance(60_000);
    for (const side of [p.mock, p.api]) {
      const res = await side.call('POST', `/v1/trucks/${tId(side, 1)}/cancel`, { body: { reason: 'Other', note: '', version: 1 } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const next = await pull(cursor);
    expectSame(next);
    const page = next[1].body as TasksPage;
    expect(page.items).toEqual([]);
    expect([...page.removed].sort()).toEqual([tId(p.api, 0), tId(p.api, 1)].sort());
    expect(page.cursor > cursor(p.api)).toBe(true);

    // At-least-once: the last change is at the cursor, so it is sent again.
    const repeat = await pull(() => page.cursor);
    expect(repeat[1].status).toBe(200);
    expect((repeat[1].body as TasksPage).removed).toContain(tId(p.api, 1));
  });

  it('Sanjay (Borai) sees none of the Siltara trucks', async () => {
    const res = await p.both('GET', () => '/v1/supervisor/tasks', () => ({ as: 'sanjay' }));
    expectSame(res);
    expect((res[1].body as TasksPage).items).toEqual([]);
  });

  it('a bad cursor is 422; plant heads and city staff get 403', async () => {
    expectSame(await p.both('GET', () => '/v1/supervisor/tasks?cursor=yesterday', () => ({ as: 'ravi' })));
    expectSame(await p.both('GET', () => '/v1/supervisor/tasks', () => ({ as: 'kiran' })));
    expectSame(await p.both('GET', () => '/v1/supervisor/tasks', () => ({ as: 'priya' })));
  });
});

describe('done today equals the mock (B3 Task 7)', () => {
  it('weighed trucks of today, newest first, awaiting approval or dispatched, with the total', async () => {
    expectSame(await p.both('GET', () => '/v1/supervisor/done-today', () => ({ as: 'ravi' })));
    await sync((s) => fullWeigh(s, 0, ids()));
    p.clock.advance(60_000);
    await sync((s) => fullWeigh(s, 1, ids()));
    p.clock.advance(60_000);
    expectSame(await p.both('POST', (s) => `/v1/trucks/${tId(s, 0)}/approve`, () => ({ body: { version: 4 } })));
    const res = await p.both('GET', () => '/v1/supervisor/done-today', () => ({ as: 'ravi' }));
    expectSame(res);
    const done = res[1].body as DoneToday;
    expect(done.items.map((x) => x.status)).toEqual(['awaiting_approval', 'dispatched']);
    expect(done.totalNetKg).toBe(10_000);
  });

  it('counts by the IST day it was weighed: yesterday’s weighing is gone after midnight', async () => {
    await sync((s) => fullWeigh(s, 0, ids()));
    p.clock.advance(24 * 3_600_000);
    const res = await p.both('GET', () => '/v1/supervisor/done-today', () => ({ as: 'ravi' }));
    expectSame(res);
    expect((res[1].body as DoneToday).items).toEqual([]);
  });
});
