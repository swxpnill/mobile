import { v7 as uuidv7 } from 'uuid';
import type { Order, Truck } from '@tonnage/shared';
import { expect } from 'vitest';
import { canvasOrder, createMasters, type Masters } from './masters.ts';
import { normaliseIds } from './normalise.ts';
import { buildParity, type Parity, type Person, type Res, type Side } from './parity.ts';

/**
 * Both sides with the canvas order and two trucks on its AIP sub-order (5 MT of the first line
 * each), the clock a minute on: the starting point of the B3 Task 8 parity tests.
 */
export interface DispatchWorld {
  p: Parity;
  m(s: Side): Masters;
  order(s: Side): Order;
  /** The order's AIP sub-order as booked. */
  aip(s: Side): Order['subOrders'][number];
  truckId(s: Side, i?: number): string;
  /** Status and body equal once ids are normalised, `changedAt` and `cursor` aside (change clock). */
  expectSame(r: [Res, Res]): void;
  /** Arrived, tare 12 t, then 5 t on the first line (weighed at version 4) under these event ids. */
  events(s: Side, truck: number, e: { atGate: string; tare: string; gross: string }): object[];
  sync(s: Side, events: object[], as?: Person): Promise<Res>;
}

const withoutClocks = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'changedAt' || k === 'cursor' ? '(clock)' : x)));

export const DEVICE = 'device-ravi-0001';

export const eventIds = () => ({ atGate: uuidv7(), tare: uuidv7(), gross: uuidv7() });

export async function buildDispatchWorld(): Promise<DispatchWorld> {
  const p = await buildParity();
  const masters = new Map<Side, Masters>();
  const orders = new Map<Side, Order>();
  const trucks = new Map<Side, Truck[]>();
  for (const side of [p.mock, p.api]) masters.set(side, await createMasters(side));
  for (const side of [p.mock, p.api]) {
    const res = await side.call('POST', '/v1/orders', { body: canvasOrder(masters.get(side)!) });
    expect(res.status).toBe(201);
    orders.set(side, res.body as Order);
  }
  const aip = (s: Side) => orders.get(s)!.subOrders[0]!;
  for (const vehicleNo of ['CG 04 MK 2291', 'CG 04 LT 6619']) {
    p.clock.advance(1_000);
    for (const side of [p.mock, p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${aip(side).id}/trucks`, {
        body: {
          vehicleNo,
          transporterId: masters.get(side)!.transporter.id,
          driverName: 'Mahesh',
          driverPhone: '9425210877',
          lrNo: '',
          plan: [{ orderLineId: aip(side).lines[0]!.id, plannedKg: 5_000 }],
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      trucks.set(side, [...(trucks.get(side) ?? []), res.body as Truck]);
    }
  }
  p.clock.advance(60_000);

  const truckId = (s: Side, i = 0) => trucks.get(s)![i]!.id;
  const events: DispatchWorld['events'] = (s, truck, e) => {
    const at = new Date(p.clock.now()).toISOString();
    return [
      { eventId: e.atGate, truckId: truckId(s, truck), deviceSeq: 1, capturedAtDevice: at, type: 'AT_GATE' },
      { eventId: e.tare, truckId: truckId(s, truck), deviceSeq: 2, capturedAtDevice: at, type: 'TARE', tareKg: 12_000 },
      {
        eventId: e.gross,
        truckId: truckId(s, truck),
        deviceSeq: 3,
        capturedAtDevice: at,
        type: 'GROSS',
        grossKg: 17_000,
        allocations: [{ orderLineId: aip(s).lines[0]!.id, netKg: 5_000 }],
      },
    ];
  };
  const sync: DispatchWorld['sync'] = (s, evs, as = 'ravi') =>
    s.call('POST', '/v1/weighments/sync', { as, body: { deviceId: DEVICE, events: evs } });
  return {
    p,
    m: (s) => masters.get(s)!,
    order: (s) => orders.get(s)!,
    aip,
    truckId,
    expectSame([mock, api]) {
      expect(api.status, JSON.stringify(api.body)).toBe(mock.status);
      expect(withoutClocks(normaliseIds(api))).toEqual(withoutClocks(normaliseIds(mock)));
    },
    events,
    sync,
  };
}
