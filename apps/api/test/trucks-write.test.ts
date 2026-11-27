import { SAMPLE_WORLD, type Order, type Truck } from '@tonnage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { canvasOrder, createMasters, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res, type Side } from './support/parity.ts';
import { waitForLockWaiters, withLockHolder } from './support/lockWait.ts';

afterEach(closeTestApps);

let p: Parity;
const masters = new Map<Side, Masters>();
const orders = new Map<Side, Order>();
const m = (s: Side) => masters.get(s)!;
const o = (s: Side) => orders.get(s)!;
const aip = (s: Side) => o(s).subOrders[0]!;
const krm = (s: Side) => o(s).subOrders[1]!;

function expectSame([mock, api]: [Res, Res]): void {
  expect(api.status, JSON.stringify(api.body)).toBe(mock.status);
  expect(normaliseIds(api)).toEqual(normaliseIds(mock));
}

beforeEach(async () => {
  p = await buildParity();
  masters.clear();
  orders.clear();
  for (const side of [p.mock, p.api]) masters.set(side, await createMasters(side));
  for (const side of [p.mock, p.api]) {
    const res = await side.call('POST', '/v1/orders', { body: canvasOrder(m(side)) });
    expect(res.status).toBe(201);
    orders.set(side, res.body as Order);
  }
});

const assignBody = (s: Side, over: Record<string, unknown> = {}) => ({
  vehicleNo: 'CG 04 MK 2291',
  transporterId: m(s).transporter.id,
  driverName: 'Mahesh',
  driverPhone: '9425210877',
  lrNo: '',
  plan: [{ orderLineId: aip(s).lines[0]!.id, plannedKg: 10_000 }],
  ...over,
});

const assignBoth = (over: (s: Side) => Record<string, unknown> = () => ({}), sub = aip) =>
  p.both('POST', (s) => `/v1/sub-orders/${sub(s).id}/trucks`, (s) => ({ body: assignBody(s, over(s)) }));

describe('assign, edit, cancel equal the mock (B3 Task 4)', () => {
  it('assign: 201 with the truck; the order shows it; the activity records it', async () => {
    const pair = await assignBoth();
    expect(pair[0].status).toBe(201);
    expectSame(pair);
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}`));
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}/activity`));
  });

  it('assign warnings: the same vehicle open elsewhere, and more than is left to assign', async () => {
    await assignBoth();
    expectSame(await assignBoth((s) => ({ plan: [{ orderLineId: aip(s).lines[0]!.id, plannedKg: 999_000 }] })));
  });

  it('assign refusals: a line of another sub-order, a foreign plant, an inactive transporter field, no key', async () => {
    expectSame(await assignBoth((s) => ({ plan: [{ orderLineId: krm(s).lines[0]!.id, plannedKg: 1_000 }] })));
    expectSame(await assignBoth(() => ({ plantId: SAMPLE_WORLD.ids.plants.borai })));
    expectSame(await assignBoth(() => ({ transporterId: SAMPLE_WORLD.ids.users.rajesh })));
    expectSame(
      await p.both('POST', (s) => `/v1/sub-orders/${aip(s).id}/trucks`, (s) => ({ body: { ...assignBody(s), plan: [] } })),
    );
  });

  it('a plant head may not assign; a truck on a closed sub-order is refused', async () => {
    expectSame(await p.both('POST', (s) => `/v1/sub-orders/${aip(s).id}/trucks`, (s) => ({ as: 'kiran', body: assignBody(s) })));
    for (const side of [p.mock, p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${aip(side).id}/short-close`, {
        body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: aip(side).version },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expectSame(await assignBoth());
  });

  it('edit: fields, plan and warnings; a stale version; a dispatched truck takes only an LR number', async () => {
    const [mockT, apiT] = (await assignBoth()).map((r) => r.body as Truck);
    const id = (s: Side) => (s === p.mock ? mockT!.id : apiT!.id);
    expectSame(
      await p.both('PATCH', (s) => `/v1/trucks/${id(s)}`, (s) => ({
        body: { driverName: 'Suresh', lrNo: 'LR-77', plan: [{ orderLineId: aip(s).lines[1]!.id, plannedKg: 999_000 }], version: 1 },
      })),
    );
    expectSame(await p.both('PATCH', (s) => `/v1/trucks/${id(s)}`, () => ({ body: { driverName: 'Old', version: 1 } })));
    const dispatched = new Map<Side, string>();
    for (const side of [p.mock, p.api]) {
      dispatched.set(
        side,
        await side.addTruck({
          subOrderId: aip(side).id,
          state: 'dispatched',
          vehicleNo: 'CG 07 BR 8810',
          tareKg: 12_000,
          plan: [{ orderLineId: aip(side).lines[0]!.id, plannedKg: 5_000 }],
          allocations: [{ orderLineId: aip(side).lines[0]!.id, netKg: 5_010 }],
        }),
      );
    }
    expectSame(await p.both('PATCH', (s) => `/v1/trucks/${dispatched.get(s)}`, () => ({ body: { driverName: 'X', version: 1 } })));
    expectSame(await p.both('PATCH', (s) => `/v1/trucks/${dispatched.get(s)}`, () => ({ body: { lrNo: 'LR-9', version: 1 } })));
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}/activity`));
  });

  it('cancel: the reason and note; a second cancel is TRUCK_LOCKED; a stale version is STALE', async () => {
    const [mockT, apiT] = (await assignBoth()).map((r) => r.body as Truck);
    const id = (s: Side) => (s === p.mock ? mockT!.id : apiT!.id);
    expectSame(await p.both('POST', (s) => `/v1/trucks/${id(s)}/cancel`, () => ({ body: { reason: 'Other', note: 'Wrong truck', version: 9 } })));
    expectSame(await p.both('POST', (s) => `/v1/trucks/${id(s)}/cancel`, () => ({ body: { reason: 'Other', note: 'Wrong truck', version: 1 } })));
    expectSame(await p.both('POST', (s) => `/v1/trucks/${id(s)}/cancel`, () => ({ body: { reason: 'Other', note: '', version: 2 } })));
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}`));
  });
});

describe('races (B3 Review Focus 4)', () => {
  it('an assignment racing a short close of the same sub-order never leaves a truck on a closed line', async () => {
    const api = p.api;
    const sub = aip(api);
    const results = await withLockHolder(p.t.ownerDb, async (client, track) => {
      // Hold the order row: both requests queue behind it, then go in whatever order Postgres picks.
      await client.query('select id from orders where id = $1 for update', [o(api).id]);
      const assign = track(api.call('POST', `/v1/sub-orders/${sub.id}/trucks`, { body: assignBody(api) }));
      const close = track(
        api.call('POST', `/v1/sub-orders/${sub.id}/short-close`, {
          body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: sub.version },
        }),
      );
      await waitForLockWaiters(p.t.ownerDb, 2);
      await client.query('commit');
      return Promise.all([assign, close]);
    });
    const [assigned, closed] = results;
    expect([200, 201, 409]).toContain(assigned.status);
    expect([200, 409]).toContain(closed.status);
    const order = (await api.call('GET', `/v1/orders/${o(api).id}`)).body as Order;
    const aipNow = order.subOrders[0]!;
    if (aipNow.closeKind !== null) {
      // Closed: no truck of it may still be open.
      const board = (await api.call('GET', '/v1/dispatch?state=open')).body as { items: Truck[] };
      expect(board.items.filter((t) => t.subOrderId === aipNow.id)).toEqual([]);
    }
  });
});
