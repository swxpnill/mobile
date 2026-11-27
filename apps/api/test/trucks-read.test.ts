import type { Order } from '@tonnage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { COMPANY, canvasOrder, createMasters, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res, type Side } from './support/parity.ts';

afterEach(closeTestApps);

let p: Parity;
const masters = new Map<Side, Masters>();
const m = (s: Side): Masters => masters.get(s)!;
/** Per side: truck ids by label. */
const trucks = new Map<Side, Record<string, string>>();
const tid = (s: Side, label: string) => trucks.get(s)![label]!;

function expectSame([mock, api]: [Res, Res]): void {
  expect(api.status, JSON.stringify(api.body)).toBe(mock.status);
  expect(normaliseIds(api)).toEqual(normaliseIds(mock));
}

/** The canvas order (AIP Siltara + KRM Borai) and five trucks in different states on each side. */
beforeEach(async () => {
  p = await buildParity();
  masters.clear();
  trucks.clear();
  for (const side of [p.mock, p.api]) masters.set(side, await createMasters(side));
  const lines = new Map<Side, { aip: string; krm: string; a0: string; a1: string; k0: string }>();
  for (const side of [p.mock, p.api]) {
    const res = await side.call('POST', '/v1/orders', { body: canvasOrder(m(side)) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [aip, krm] = (res.body as Order).subOrders;
    lines.set(side, { aip: aip!.id, krm: krm!.id, a0: aip!.lines[0]!.id, a1: aip!.lines[1]!.id, k0: krm!.lines[0]!.id });
    trucks.set(side, {});
  }
  // Each truck on both sides at the same moment, a minute apart.
  const specs: [string, (s: Side) => Parameters<Side['addTruck']>[0]][] = [
    ['assigned', (s) => ({ subOrderId: lines.get(s)!.aip, state: 'assigned', vehicleNo: 'CG 04 MK 2291', plan: [{ orderLineId: lines.get(s)!.a0, plannedKg: 10_000 }] })],
    ['loading', (s) => ({ subOrderId: lines.get(s)!.aip, state: 'loading', vehicleNo: 'CG 07 KL 3304', tareKg: 11_900, plan: [{ orderLineId: lines.get(s)!.a1, plannedKg: 8_000 }] })],
    [
      'weighed',
      (s) => ({
        subOrderId: lines.get(s)!.krm,
        state: 'weighed',
        vehicleNo: 'CG 04 LT 6619',
        transporterId: m(s).transporter.id,
        tareKg: 12_000,
        plan: [{ orderLineId: lines.get(s)!.k0, plannedKg: 11_000 }],
        allocations: [{ orderLineId: lines.get(s)!.k0, netKg: 10_850 }],
      }),
    ],
    [
      'dispatched',
      (s) => ({
        subOrderId: lines.get(s)!.aip,
        state: 'dispatched',
        vehicleNo: 'cg 04 mk 2291',
        tareKg: 12_100,
        plan: [{ orderLineId: lines.get(s)!.a0, plannedKg: 9_000 }],
        allocations: [{ orderLineId: lines.get(s)!.a0, netKg: 9_040 }],
      }),
    ],
    ['cancelled', (s) => ({ subOrderId: lines.get(s)!.krm, state: 'cancelled', vehicleNo: 'MH 40 AT 1182', plan: [{ orderLineId: lines.get(s)!.k0, plannedKg: 5_000 }] })],
  ];
  for (const [label, spec] of specs) {
    for (const side of [p.mock, p.api]) trucks.get(side)![label] = await side.addTruck(spec(side));
    p.clock.advance(60_000);
  }
});

describe('truck reads equal the mock (B3 Task 3)', () => {
  it('truck detail in each state, for the owner and for Kiran (plant head, no money)', async () => {
    for (const label of ['assigned', 'loading', 'weighed', 'dispatched', 'cancelled']) {
      expectSame(await p.both('GET', (s) => `/v1/trucks/${tid(s, label)}`));
    }
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tid(s, 'loading')}`, () => ({ as: 'kiran' })));
    // Borai is not Kiran's plant: 404 on both.
    expectSame(await p.both('GET', (s) => `/v1/trucks/${tid(s, 'weighed')}`, () => ({ as: 'kiran' })));
  });

  it('the dispatch board for every state filter, by company, with search, and for Kiran', async () => {
    for (const state of ['open', 'assigned', 'at_gate', 'loading', 'weighed', 'dispatched_today']) {
      expectSame(await p.both('GET', () => `/v1/dispatch?state=${state}`));
    }
    expectSame(await p.both('GET', () => `/v1/dispatch?companyId=${COMPANY.AIP}&state=open`));
    for (const q of ['cg04mk', 'CG 07', 'SO-', 'shubham', 'nothing-like-this']) {
      expectSame(await p.both('GET', () => `/v1/dispatch?state=open&q=${encodeURIComponent(q)}`));
    }
    expectSame(await p.both('GET', () => '/v1/dispatch?state=open', () => ({ as: 'kiran' })));
  });

  it('recent vehicles: newest first, one per vehicle however typed', async () => {
    expectSame(await p.both('GET', () => '/v1/trucks/recent-vehicles'));
  });

  it('an unknown or malformed truck id is 404', async () => {
    expectSame(await p.both('GET', () => '/v1/trucks/019a4c00-0000-7000-8000-00000000dead'));
    expectSame(await p.both('GET', () => '/v1/trucks/not-a-uuid'));
  });
});
