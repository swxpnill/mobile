import type { Home, Order } from '@tonnage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { COMPANY, canvasOrder, createMasters, krmOrder, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Person, type Res, type Side } from './support/parity.ts';

afterEach(closeTestApps);

const HOUR = 60 * 60_000;
/** 23:30 IST on 3 Nov 2026 (18:00 UTC), half an hour before the IST day changes. */
const LATE_EVENING = Date.parse('2026-11-03T18:00:00.000Z');

let p: Parity;
const masters = new Map<Side, Masters>();
const m = (s: Side): Masters => {
  const found = masters.get(s);
  if (!found) throw new Error('no masters');
  return found;
};
const same = ([mock, api]: [Res, Res]) => expect(normaliseIds(api)).toEqual(normaliseIds(mock));

async function setup(start?: number): Promise<void> {
  p = await buildParity(start);
  masters.set(p.mock, await createMasters(p.mock));
  masters.set(p.api, await createMasters(p.api));
}
beforeEach(() => masters.clear());

async function book(body: (x: Masters) => object): Promise<Map<Side, Order>> {
  const out = new Map<Side, Order>();
  for (const s of [p.mock, p.api]) {
    const res = await s.call('POST', '/v1/orders', { body: body(m(s)) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    out.set(s, res.body as Order);
  }
  return out;
}

const home = (as: Person, query = '') => p.both('GET', () => `/v1/home${query}`, () => ({ as }));

describe('Home equals the mock', () => {
  it('per-company pending, booked today, in plant, for the owner, city staff and every unit filter', async () => {
    await setup();
    const canvas = await book(canvasOrder);
    await book(krmOrder);
    for (const s of [p.mock, p.api]) {
      const [aip, krm] = canvas.get(s)?.subOrders ?? [];
      if (!aip || !krm) throw new Error('two sub-orders expected');
      await s.addTruck({
        subOrderId: krm.id,
        state: 'dispatched',
        vehicleNo: 'CG 07 BR 8810',
        tareKg: 12_000,
        plan: [{ orderLineId: krm.lines[0]!.id, plannedKg: 25_000 }],
        allocations: [{ orderLineId: krm.lines[0]!.id, netKg: 24_800 }],
      });
      await s.addTruck({
        subOrderId: aip.id,
        state: 'assigned',
        vehicleNo: 'CG 04 LT 6619',
        plan: [{ orderLineId: aip.lines[0]!.id, plannedKg: 18_000 }],
      });
      await s.addTruck({
        subOrderId: aip.id,
        state: 'weighed',
        vehicleNo: 'CG 04 MK 2291',
        tareKg: 11_000,
        plan: [{ orderLineId: aip.lines[1]!.id, plannedKg: 9_000 }],
        allocations: [{ orderLineId: aip.lines[1]!.id, netKg: 9_100 }],
      });
    }
    const owner = await home('rajesh');
    expect(owner[1].status).toBe(200);
    expect(owner[1].body).toMatchObject({
      openOrders: 2,
      bookedToday: { orders: 2 },
      dispatchedToday: { kg: 24_800, trucks: 1 },
    });
    expect((owner[1].body as Home).inPlant.map((t) => [t.vehicleNo, t.state])).toEqual([
      ['CG 04 MK 2291', 'weighed'],
      ['CG 04 LT 6619', 'assigned'],
    ]);
    same(owner);
    same(await home('priya'));
    for (const id of Object.values(COMPANY)) same(await home('rajesh', `?companyId=${id}`));
  });

  it('dispatched today and booked today count by IST date, not UTC', async () => {
    await setup(LATE_EVENING);
    const first = await book(krmOrder);
    const dispatch = async (vehicleNo: string, kg: number) => {
      for (const s of [p.mock, p.api]) {
        const sub = first.get(s)?.subOrders[0];
        if (!sub) throw new Error('no sub-order');
        await s.addTruck({
          subOrderId: sub.id,
          state: 'dispatched',
          vehicleNo,
          tareKg: 10_000,
          plan: [{ orderLineId: sub.lines[0]!.id, plannedKg: kg }],
          allocations: [{ orderLineId: sub.lines[0]!.id, netKg: kg }],
        });
      }
    };
    // 23:30 IST: this truck and the order are today.
    await dispatch('CG 07 AA 0001', 20_000);
    expect(((await home('rajesh'))[1].body as Home).dispatchedToday.trucks).toBe(1);
    // 00:30 IST the next day, the same UTC day: yesterday's truck is no longer today's.
    p.clock.advance(HOUR);
    const next = await home('rajesh');
    expect(next[1].body).toMatchObject({ dispatchedToday: { kg: 0, trucks: 0 }, bookedToday: { orders: 0, kg: 0 } });
    await dispatch('CG 07 AA 0002', 22_000);
    const after = await home('rajesh');
    expect(after[1].body).toMatchObject({ dispatchedToday: { kg: 22_000, trucks: 1 }, bookedToday: { orders: 0 } });
    same(next);
    same(after);
  });

  it('a unit outside the caller scope is 404, a malformed id 422', async () => {
    await setup();
    await book(krmOrder);
    // Kiran runs Siltara: some company is not his.
    const kiran: [Res, Res][] = [];
    for (const id of Object.values(COMPANY)) kiran.push(await home('kiran', `?companyId=${id}`));
    expect(kiran.some(([, a]) => a.status === 404)).toBe(true);
    for (const pair of kiran) same(pair);
    same(await home('rajesh', '?companyId=nope'));
  });
});

describe('Home: week, change and aged orders equal the mock', () => {
  const dispatchOn = async (orders: Map<Side, Order>, vehicleNo: string, kg: number) => {
    for (const s of [p.mock, p.api]) {
      const sub = orders.get(s)?.subOrders[0];
      if (!sub) throw new Error('no sub-order');
      await s.addTruck({
        subOrderId: sub.id,
        state: 'dispatched',
        vehicleNo,
        tareKg: 10_000,
        plan: [{ orderLineId: sub.lines[0]!.id, plannedKg: kg }],
        allocations: [{ orderLineId: sub.lines[0]!.id, netKg: kg }],
      });
    }
  };

  it('sentThisWeek and changePct against last week (Monday 00:00 IST boundary)', async () => {
    await setup();
    const o = await book(krmOrder);
    // Last week's dispatch (Tue 27 Oct), then this week's (Tue 3 Nov): +50 %.
    p.clock.advance(-7 * 24 * HOUR);
    await dispatchOn(o, 'CG 07 AA 0001', 20_000);
    p.clock.advance(7 * 24 * HOUR);
    await dispatchOn(o, 'CG 07 AA 0002', 30_000);
    const res = await home('rajesh');
    expect(res[1].body).toMatchObject({ sentThisWeek: { kg: 30_000, changePct: 50 } });
    same(res);
    // Sunday 8 Nov 23:59 IST is still this week; Monday 00:00 IST starts a new one.
    p.clock.advance(5 * 24 * HOUR + 13 * HOUR + 59 * 60_000); // Sun 23:59 IST
    expect(((await home('rajesh'))[1].body as Home).sentThisWeek).toEqual({ kg: 30_000, changePct: 50 });
    same(await home('rajesh'));
    p.clock.advance(60_000); // Mon 00:00 IST
    const monday = await home('rajesh');
    expect(monday[1].body).toMatchObject({ sentThisWeek: { kg: 0, changePct: -100 } });
    same(monday);
  });

  it('agedOrders counts open orders with pending older than the setting', async () => {
    await setup();
    await book(krmOrder);
    const fresh = await home('rajesh');
    expect(fresh[1].body).toMatchObject({ agedOrders: 0 });
    const days = (fresh[1].body as Home).agedOrderDays;
    p.clock.advance(days * 24 * HOUR);
    expect(((await home('rajesh'))[1].body as Home).agedOrders).toBe(0);
    p.clock.advance(24 * HOUR);
    const aged = await home('rajesh');
    expect(aged[1].body).toMatchObject({ agedOrders: 1 });
    same(aged);
  });
});

describe('Home for a plant head', () => {
  it('shows no money keys and only his plants trucks', async () => {
    await setup();
    const canvas = await book(canvasOrder);
    for (const s of [p.mock, p.api]) {
      const aip = canvas.get(s)?.subOrders[0];
      if (!aip) throw new Error('no sub-order');
      await s.addTruck({
        subOrderId: aip.id,
        state: 'assigned',
        vehicleNo: 'CG 04 LT 6619',
        plan: [{ orderLineId: aip.lines[0]!.id, plannedKg: 18_000 }],
      });
    }
    const res = await home('kiran');
    expect(res[1].status).toBe(200);
    expect(JSON.stringify(res[1].body)).not.toMatch(/valueRupees|Rupees|estimated|commission/i);
    expect((res[1].body as Home).bookedToday).not.toHaveProperty('valueRupees');
    same(res);
    // The owner's has it.
    expect(((await home('rajesh'))[1].body as Home).bookedToday.valueRupees).toBeGreaterThan(0);
  });
});
