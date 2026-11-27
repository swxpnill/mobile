import { type Order, type SyncResponse, type Truck } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { waitForLockWaiters, withLockHolder } from './support/lockWait.ts';
import { canvasOrder, createMasters, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res, type Side } from './support/parity.ts';

afterEach(closeTestApps);

let p: Parity;
const masters = new Map<Side, Masters>();
const orders = new Map<Side, Order>();
const truckOf = new Map<Side, Truck>();
const m = (s: Side) => masters.get(s)!;
const o = (s: Side) => orders.get(s)!;
const aip = (s: Side) => o(s).subOrders[0]!;
const tId = (s: Side) => truckOf.get(s)!.id;

/**
 * A task's `changedAt` is the tenant change clock on the API (B3 Ruling 3): strictly increasing, so a
 * second change in the same millisecond reads 1 ms later than the mock's. Its exact value is not
 * compared; the contract only asks that it moves.
 */
const withoutChangedAt = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'changedAt' ? '(changed)' : x)));

function expectSame([mock, api]: [Res, Res]): void {
  expect(api.status, JSON.stringify(api.body)).toBe(mock.status);
  expect(withoutChangedAt(normaliseIds(api))).toEqual(withoutChangedAt(normaliseIds(mock)));
}

const DEVICE = 'device-ravi-0001';
/** One event id per step, shared by both sides (each side keeps its own store). */
const ev = { atGate: uuidv7(), tare: uuidv7(), gross: uuidv7() };

const event = (s: Side, type: 'AT_GATE' | 'TARE' | 'GROSS', extra: Record<string, unknown> = {}) => ({
  eventId: type === 'AT_GATE' ? ev.atGate : type === 'TARE' ? ev.tare : ev.gross,
  truckId: tId(s),
  deviceSeq: type === 'AT_GATE' ? 1 : type === 'TARE' ? 2 : 3,
  capturedAtDevice: new Date(p.clock.now()).toISOString(),
  type,
  ...extra,
});

const syncBoth = (events: (s: Side) => object[]) =>
  p.both('POST', () => '/v1/weighments/sync', (s) => ({ as: 'ravi', body: { deviceId: DEVICE, events: events(s) } }));

const gross = (s: Side) =>
  event(s, 'GROSS', {
    grossKg: 12_000 + 14_000 + 9_000,
    allocations: [
      { orderLineId: aip(s).lines[0]!.id, netKg: 14_000 },
      { orderLineId: aip(s).lines[1]!.id, netKg: 9_000 },
    ],
  });

beforeEach(async () => {
  p = await buildParity();
  masters.clear();
  orders.clear();
  truckOf.clear();
  for (const side of [p.mock, p.api]) masters.set(side, await createMasters(side));
  for (const side of [p.mock, p.api]) {
    const res = await side.call('POST', '/v1/orders', { body: canvasOrder(m(side)) });
    expect(res.status).toBe(201);
    orders.set(side, res.body as Order);
  }
  for (const side of [p.mock, p.api]) {
    const res = await side.call('POST', `/v1/sub-orders/${aip(side).id}/trucks`, {
      body: {
        vehicleNo: 'CG 04 MK 2291',
        transporterId: m(side).transporter.id,
        driverName: 'Mahesh',
        driverPhone: '9425210877',
        lrNo: '',
        plan: [
          { orderLineId: aip(side).lines[0]!.id, plannedKg: 14_000 },
          { orderLineId: aip(side).lines[1]!.id, plannedKg: 9_000 },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    truckOf.set(side, res.body as Truck);
  }
});

describe('the dispatch core equals the mock (B3 Task 5)', () => {
  it('TON-57 path: arrived → tare → product weights → approve, with slip, earning and activity', async () => {
    p.clock.advance(60_000);
    expectSame(await syncBoth((s) => [event(s, 'AT_GATE')]));
    p.clock.advance(60_000);
    expectSame(await syncBoth((s) => [event(s, 'TARE', { tareKg: 12_000 })]));
    p.clock.advance(60_000);
    expectSame(await syncBoth((s) => [gross(s)]));
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tId(s)}`));
    p.clock.advance(60_000);
    const approved = await p.both('POST', (s) => `/v1/trucks/${tId(s)}/approve`, () => ({ body: { version: 4 } }));
    expectSame(approved);
    expect((approved[1].body as Truck).loadingSlipNo).toMatch(/^LS-AIP-\d{4}-0001$/);
    expect((approved[1].body as Truck).earningRupees).toBeGreaterThan(0);
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}`));
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}/activity`));
  });

  it('refusals: tare before arrival, gross before tare, a second gross, approving twice or with a stale version', async () => {
    expectSame(await syncBoth((s) => [event(s, 'TARE', { tareKg: 12_000 })]));
    // A fresh request on a new key: the blocked truck's later events are refused too.
    expectSame(await syncBoth((s) => [{ ...gross(s), eventId: uuidv7() }]));
    expectSame(await p.both('POST', (s) => `/v1/trucks/${tId(s)}/approve`, () => ({ body: { version: 1 } })));
    // The Needs attention list arrives in Task 8; the API's rows are checked directly here.
    const rejected = await p.t.ownerDb.$client.query(`select code, status from weighment_rejections where truck_id = $1`, [tId(p.api)]);
    expect(rejected.rows.length).toBeGreaterThan(0);
    expect(rejected.rows.every((r: { status: string }) => r.status === 'open')).toBe(true);
  });

  it('replays: the same key answers the first answer; the same events on a new key are duplicates', async () => {
    const key = uuidv7();
    const first = await p.both('POST', () => '/v1/weighments/sync', (s) => ({ as: 'ravi', key, body: { deviceId: DEVICE, events: [event(s, 'AT_GATE')] } }));
    const again = await p.both('POST', () => '/v1/weighments/sync', (s) => ({ as: 'ravi', key, body: { deviceId: DEVICE, events: [event(s, 'AT_GATE')] } }));
    expectSame(first);
    expectSame(again);
    expect(again[1].body).toEqual(first[1].body);
    const dup = await syncBoth((s) => [event(s, 'AT_GATE')]);
    expectSame(dup);
    expect((dup[1].body as SyncResponse).results[0]!.status).toBe('duplicate');
  });

  it('tolerance: the last truck within 1,000 kg closes the sub-order', async () => {
    // A second truck takes the rest of both lines but 400 kg: the sub-order closes on approval.
    for (const side of [p.mock, p.api]) {
      await side.call('POST', '/v1/weighments/sync', { as: 'ravi', body: { deviceId: DEVICE, events: [event(side, 'AT_GATE'), event(side, 'TARE', { tareKg: 12_000 })] } });
    }
    const left = (s: Side) => aip(s).lines.map((l) => l.orderedKg);
    expectSame(
      await syncBoth((s) => [
        event(s, 'GROSS', {
          grossKg: 12_000 + left(s).reduce((n, kg) => n + kg, 0) - 400,
          // Every line of the sub-order loaded in full, but 400 kg short on the first.
          allocations: aip(s).lines.map((l, i) => ({ orderLineId: l.id, netKg: left(s)[i]! - (i === 0 ? 400 : 0) })),
        }),
      ]),
    );
    expectSame(await p.both('POST', (s) => `/v1/trucks/${tId(s)}/approve`, () => ({ body: { version: 4 } })));
    const after = await p.both('GET', (s) => `/v1/orders/${o(s).id}`);
    expectSame(after);
    // Both close it: the parity alone would pass if neither did.
    expect((after[0].body as Order).subOrders[0]!.closeKind).toBe('tolerance');
    expect((after[1].body as Order).subOrders[0]!.closeKind).toBe('tolerance');
  });

  it('a gross after the sub-order was short closed is TRUCK_CANCELLED and lands in Needs attention', async () => {
    for (const side of [p.mock, p.api]) {
      await side.call('POST', '/v1/weighments/sync', { as: 'ravi', body: { deviceId: DEVICE, events: [event(side, 'AT_GATE'), event(side, 'TARE', { tareKg: 12_000 })] } });
      const res = await side.call('POST', `/v1/sub-orders/${aip(side).id}/short-close`, {
        body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: aip(side).version },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expectSame(await syncBoth((s) => [gross(s)]));
    // The Needs attention list arrives in Task 8; the API's rows are checked directly here.
    const rejected = await p.t.ownerDb.$client.query(`select code, status from weighment_rejections where truck_id = $1`, [tId(p.api)]);
    expect(rejected.rows.length).toBeGreaterThan(0);
    expect(rejected.rows.every((r: { status: string }) => r.status === 'open')).toBe(true);
  });
});

describe('two approvals at once (B3 Review Focus 1)', () => {
  it('exactly one dispatches: one slip, one earning; the other is NOT_AWAITING_APPROVAL', async () => {
    const api = p.api;
    await api.call('POST', '/v1/weighments/sync', {
      as: 'ravi',
      body: { deviceId: DEVICE, events: [event(api, 'AT_GATE'), event(api, 'TARE', { tareKg: 12_000 }), gross(api)] },
    });
    const [a, b] = await withLockHolder(p.t.ownerDb, async (client, track) => {
      await client.query('select id from orders where id = $1 for update', [o(api).id]);
      const one = track(api.call('POST', `/v1/trucks/${tId(api)}/approve`, { body: { version: 4 } }));
      const two = track(api.call('POST', `/v1/trucks/${tId(api)}/approve`, { as: 'priya', body: { version: 4 } }));
      await waitForLockWaiters(p.t.ownerDb, 2);
      await client.query('commit');
      return Promise.all([one, two]);
    });
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((loser.body as { code: string }).code).toBe('NOT_AWAITING_APPROVAL');
    const ledger = await p.t.ownerDb.$client.query('select kind from broker_ledger where truck_id = $1', [tId(api)]);
    expect(ledger.rows).toEqual([{ kind: 'earning' }]);
    const slips = await p.t.ownerDb.$client.query(`select loading_slip_no from trucks where loading_slip_no is not null`);
    expect(slips.rows).toHaveLength(1);
  });
});
