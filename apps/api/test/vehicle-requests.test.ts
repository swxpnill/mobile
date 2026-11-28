import { type Order } from '@tonnage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { buildDispatchWorld, type DispatchWorld } from './support/dispatchWorld.ts';
import type { Side } from './support/parity.ts';

afterEach(closeTestApps);

let w: DispatchWorld;
beforeEach(async () => {
  w = await buildDispatchWorld();
});

/** Every sub-order's first line, 2 MT each, asked of the broker. */
const request = (s: Side, over: Record<string, unknown> = {}) => {
  const lines = w.order(s).subOrders.map((sub) => ({ orderLineId: sub.lines[0]!.id, kg: 2_000 }));
  return {
    partyId: w.m(s).broker.id,
    contactName: 'R.K. Agarwal',
    number: '+919826100099',
    channel: 'whatsapp',
    lines,
    totalKg: lines.reduce((n, l) => n + l.kg, 0),
    ...over,
  };
};
const send = (body: (s: Side) => unknown) => w.p.both('POST', (s) => `/v1/orders/${w.order(s).id}/vehicle-requests`, (s) => ({ body: body(s) }));
const order = (as?: 'kiran') => w.p.both('GET', (s) => `/v1/orders/${w.order(s).id}`, () => (as ? { as } : {}));

describe('vehicle requests equal the mock (B3 Task 8)', () => {
  it('201 with the request; the order lists it, a plant head sees only their lines; the activity records it', async () => {
    const res = await send((s) => request(s));
    w.expectSame(res);
    expect(res[1].status).toBe(201);
    const seen = await order();
    w.expectSame(seen);
    expect((seen[1].body as Order).vehicleRequests).toHaveLength(1);
    w.expectSame(await order('kiran'));
    w.expectSame(await w.p.both('GET', (s) => `/v1/orders/${w.order(s).id}/activity`));
  });

  it('a truck assigned after it closes it; one assigned before does not', async () => {
    await send((s) => request(s));
    w.expectSame(await order());
    w.p.clock.advance(60_000);
    for (const side of [w.p.mock, w.p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${w.aip(side).id}/trucks`, {
        body: {
          vehicleNo: 'CG 04 ZZ 1234',
          transporterId: null,
          driverName: 'Driver',
          driverPhone: '9425210877',
          lrNo: '',
          plan: [{ orderLineId: w.aip(side).lines[0]!.id, plannedKg: 2_000 }],
        },
      });
      expect(res.status).toBe(201);
    }
    const after = await order();
    w.expectSame(after);
    expect((after[1].body as Order).vehicleRequests).toEqual([]);
  });

  it('422 paths: a line over pending, a total that does not add up, a party not on the order', async () => {
    w.expectSame(await send((s) => request(s, { lines: [{ orderLineId: w.aip(s).lines[0]!.id, kg: 999_000_000 }], totalKg: 999_000_000 })));
    w.expectSame(await send((s) => request(s, { totalKg: 1 })));
    w.expectSame(await send((s) => request(s, { partyId: w.m(s).transporter.id })));
    w.expectSame(await send((s) => request(s, { lines: [{ orderLineId: '019a4c00-0000-7000-8000-00000000dead', kg: 1_000 }], totalKg: 1_000 })));
    w.expectSame(await w.p.both('POST', (s) => `/v1/orders/${w.order(s).id}/vehicle-requests`, (s) => ({ as: 'ravi', body: request(s) })));
  });
});
