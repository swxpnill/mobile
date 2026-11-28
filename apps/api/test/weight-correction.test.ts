import { type BrokerLedger, type Order, type Truck } from '@tonnage/shared';
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
const truckOf = new Map<Side, Truck>();
const m = (s: Side) => masters.get(s)!;
const o = (s: Side) => orders.get(s)!;
const aip = (s: Side) => o(s).subOrders[0]!;
const tId = (s: Side) => truckOf.get(s)!.id;
const line = (s: Side, i: number) => aip(s).lines[i]!;

/** The tenant change clock makes `changedAt` differ by a millisecond at most (B3 Ruling 3). */
const withoutChangedAt = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'changedAt' ? '(changed)' : x)));

function expectSame([mock, api]: [Res, Res]): void {
  expect(api.status, JSON.stringify(api.body)).toBe(mock.status);
  expect(withoutChangedAt(normaliseIds(api))).toEqual(withoutChangedAt(normaliseIds(mock)));
}

const DEVICE = 'device-ravi-0001';
const TARE = 12_000;

/** Arrived, tare, then the gross with these line weights; the truck is weighed at version 4. */
async function weigh(allocations: (s: Side) => { orderLineId: string; netKg: number }[]): Promise<void> {
  const ids = { atGate: uuidv7(), tare: uuidv7(), gross: uuidv7() };
  for (const side of [p.mock, p.api]) {
    const at = () => new Date(p.clock.now()).toISOString();
    const allocs = allocations(side);
    const res = await side.call('POST', '/v1/weighments/sync', {
      as: 'ravi',
      body: {
        deviceId: DEVICE,
        events: [
          { eventId: ids.atGate, truckId: tId(side), deviceSeq: 1, capturedAtDevice: at(), type: 'AT_GATE' },
          { eventId: ids.tare, truckId: tId(side), deviceSeq: 2, capturedAtDevice: at(), type: 'TARE', tareKg: TARE },
          {
            eventId: ids.gross,
            truckId: tId(side),
            deviceSeq: 3,
            capturedAtDevice: at(),
            type: 'GROSS',
            grossKg: TARE + allocs.reduce((n, a) => n + a.netKg, 0),
            allocations: allocs,
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}

const approve = (version: number) => p.both('POST', (s) => `/v1/trucks/${tId(s)}/approve`, () => ({ body: { version } }));

const correct = (body: (s: Side) => Record<string, unknown>) =>
  p.both('POST', (s) => `/v1/trucks/${tId(s)}/correct-weight`, (s) => ({ body: { reason: 'Weighbridge recalibrated', ...body(s) } }));

/** The correction body for these line weights on the same tare. */
const reweigh = (s: Side, allocations: { orderLineId: string; netKg: number }[], version: number) => ({
  tareKg: TARE,
  grossKg: TARE + allocations.reduce((n, a) => n + a.netKg, 0),
  allocations,
  version,
});

async function apiLedger(): Promise<{ kind: string; amount: number }[]> {
  const r = await p.t.ownerDb.$client.query(
    'select kind, amount_rupees::int as amount from broker_ledger where truck_id = $1 order by created_at, id',
    [tId(p.api)],
  );
  return r.rows as { kind: string; amount: number }[];
}

async function mockLedger(): Promise<{ kind: string; amount: number }[]> {
  const res = await p.mock.call('GET', `/v1/brokers/${m(p.mock).broker.id}/ledger`);
  expect(res.status).toBe(200);
  return (res.body as BrokerLedger).items
    .filter((r) => r.truck?.truckId === tId(p.mock))
    .reverse()
    .map((r) => ({ kind: r.kind, amount: r.amountRupees }));
}

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
          { orderLineId: line(side, 0).id, plannedKg: 14_000 },
          { orderLineId: line(side, 1).id, plannedKg: 9_000 },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    truckOf.set(side, res.body as Truck);
  }
  p.clock.advance(60_000);
});

describe('weight correction equals the mock (B3 Task 6)', () => {
  const planned = (s: Side) => [
    { orderLineId: line(s, 0).id, netKg: 14_000 },
    { orderLineId: line(s, 1).id, netKg: 9_000 },
  ];

  it('while weighed it only replaces the weights; the approval then earns on the corrected net', async () => {
    await weigh(planned);
    p.clock.advance(60_000);
    const corrected = await correct((s) =>
      reweigh(s, [{ orderLineId: line(s, 0).id, netKg: 13_500 }, { orderLineId: line(s, 1).id, netKg: 9_000 }], 4),
    );
    expectSame(corrected);
    expect((corrected[1].body as Truck).state).toBe('weighed');
    expect(await apiLedger()).toEqual([]);
    p.clock.advance(60_000);
    expectSame(await approve(5));
    const ledger = await apiLedger();
    expect(ledger.map((r) => r.kind)).toEqual(['earning']);
    expect(ledger).toEqual(await mockLedger());
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tId(s)}`));
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}/activity`));
  });

  it('after dispatch it undoes the tolerance close and rewrites the earning (Review Focus 5)', async () => {
    // Every line in full but 400 kg short on the first: the approval closes the sub-order.
    const full = (s: Side) => aip(s).lines.map((l, i) => ({ orderLineId: l.id, netKg: l.orderedKg - (i === 0 ? 400 : 0) }));
    await weigh(full);
    p.clock.advance(60_000);
    expectSame(await approve(4));
    const closed = await p.both('GET', (s) => `/v1/orders/${o(s).id}`);
    expect((closed[1].body as Order).subOrders[0]!.closeKind).toBe('tolerance');

    // A day later the first line was 2,000 kg less: 2,400 pending, over the 1,000 kg tolerance.
    p.clock.advance(24 * 3_600_000);
    const less = (s: Side) => full(s).map((a, i) => (i === 0 ? { ...a, netKg: a.netKg - 2_000 } : a));
    expectSame(await correct((s) => reweigh(s, less(s), 5)));
    const reopened = await p.both('GET', (s) => `/v1/orders/${o(s).id}`);
    expectSame(reopened);
    expect((reopened[0].body as Order).subOrders[0]!.closeKind).toBeNull();
    expect((reopened[1].body as Order).subOrders[0]!.closeKind).toBeNull();

    const ledger = await apiLedger();
    expect(ledger.map((r) => r.kind)).toEqual(['earning', 'reversal', 'earning']);
    expect(ledger[1]!.amount).toBe(-ledger[0]!.amount);
    expect(ledger).toEqual(await mockLedger());

    // Back within tolerance: it closes again.
    p.clock.advance(60_000);
    expectSame(await correct((s) => reweigh(s, full(s), 6)));
    const again = await p.both('GET', (s) => `/v1/orders/${o(s).id}`);
    expectSame(again);
    expect((again[1].body as Order).subOrders[0]!.closeKind).toBe('tolerance');
    expect(await apiLedger()).toEqual(await mockLedger());
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tId(s)}`));
    expectSame(await p.both('GET', (s) => `/v1/orders/${o(s).id}/activity`));
  });

  it('allocations that do not add up to the new net are refused, with nothing written', async () => {
    await weigh(planned);
    const before = await p.t.ownerDb.$client.query('select count(*)::int as n from weighments where truck_id = $1', [tId(p.api)]);
    const res = await correct((s) => ({ ...reweigh(s, planned(s), 4), grossKg: TARE + 22_000 }));
    expectSame(res);
    expect(res[1].status).toBe(409);
    const after = await p.t.ownerDb.$client.query('select count(*)::int as n from weighments where truck_id = $1', [tId(p.api)]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tId(s)}`));
  });

  it('a stale version is STALE; a plant head is refused', async () => {
    await weigh(planned);
    const stale = await correct((s) => reweigh(s, planned(s), 3));
    expectSame(stale);
    expect((stale[1].body as { code: string }).code).toBe('STALE');
    expectSame(
      await p.both('POST', (s) => `/v1/trucks/${tId(s)}/correct-weight`, (s) => ({
        as: 'kiran',
        body: { reason: 'Weighbridge recalibrated', ...reweigh(s, planned(s), 4) },
      })),
    );
  });

  it('a truck that is not weighed yet is TRUCK_LOCKED', async () => {
    const res = await correct((s) => reweigh(s, planned(s), 1));
    expectSame(res);
    expect((res[1].body as { code: string }).code).toBe('TRUCK_LOCKED');
  });
});
