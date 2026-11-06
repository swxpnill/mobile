import { describe, expect, it } from 'vitest';
import { SAMPLE_MASTERS, SAMPLE_WORLD } from '@tonnage/shared';
import { createFakeClock, DAY } from './clock.ts';
import { createMemoryStorage, seedState } from './store.ts';
import { createMockApi } from './index.ts';
import { addTruck } from './trucks.ts';
import { nextNumber, orderMath } from './orders-math.ts';
import { seedDemoOrders } from './seed-orders.ts';

const START = Date.UTC(2026, 10, 3, 4, 30); // 3 Nov 2026, 10:00 IST
const tenant = SAMPLE_WORLD.ids.tenant;

function demoState() {
  const clock = createFakeClock(START);
  const s = seedState(clock);
  seedDemoOrders(s, clock);
  return s;
}

describe('seed', () => {
  it('masters are seeded for the sample tenant: 8 parties, 10 products', () => {
    const s = seedState(createFakeClock(START));
    expect(s.parties).toHaveLength(8);
    expect(s.products).toHaveLength(10);
    expect(s.parties.every((p) => p.tenantId === tenant)).toBe(true);
    const billet = s.products.find((p) => p.id === SAMPLE_MASTERS.ids.products.billet)!;
    expect(billet.companyIds).toHaveLength(3);
  });

  it('the plain seed has no orders (contract tests start clean)', () => {
    expect(seedState(createFakeClock(START)).orders).toHaveLength(0);
  });

  it('demo orders: the five canvas rows with their derived statuses', () => {
    const s = demoState();
    const m = orderMath(s);
    const byNumber = Object.fromEntries(s.orders.map((o) => [o.number, m.orderStatus(o)]));
    expect(byNumber).toEqual({
      'SO-2611-0142': 'open',
      'SO-2611-0141': 'partly_dispatched',
      'SO-2610-0139': 'open',
      'SO-2610-0136': 'short_closed',
      'SO-2610-0131': 'completed',
    });
  });

  it('demo order 0141: 72.400 MT dispatched of 120.000, one truck loading with its tare', () => {
    const s = demoState();
    const m = orderMath(s);
    const o = s.orders.find((x) => x.number === 'SO-2611-0141')!;
    const sub = m.subOrdersOf(o.id)[0]!;
    expect(m.subOrderTotals(sub)).toMatchObject({ orderedKg: 120_000, dispatchedKg: 72_400, pendingKg: 47_600 });
    expect(m.openTrucksOf(sub.id)).toEqual([
      expect.objectContaining({ vehicleNo: 'CG 07 BR 8810', state: 'loading', tareKg: 12_460 }),
    ]);
  });

  it('the next order number continues the series: SO-2611-0143', () => {
    const s = demoState();
    expect(nextNumber(s, tenant, 'order', '2026-11-03T05:00:00Z')).toBe(143);
    expect(nextNumber(s, tenant, 'order', '2026-11-03T05:00:00Z')).toBe(144);
  });
});

describe('orderMath', () => {
  it('a cancelled truck reserves nothing; a dispatched truck counts its allocation once', () => {
    const s = demoState();
    const o = s.orders.find((x) => x.number === 'SO-2611-0142')!;
    const m0 = orderMath(s);
    const sub = m0.subOrdersOf(o.id)[0]!;
    const line = m0.linesOf(sub.id)[0]!;
    addTruck(s, { subOrderId: sub.id, state: 'assigned', vehicleNo: 'CG 04 AA 0001', plan: [{ orderLineId: line.id, plannedKg: 5_000 }] }, START);
    addTruck(s, { subOrderId: sub.id, state: 'cancelled', vehicleNo: 'CG 04 AA 0002', plan: [{ orderLineId: line.id, plannedKg: 7_000 }] }, START);
    addTruck(
      s,
      { subOrderId: sub.id, state: 'dispatched', vehicleNo: 'CG 04 AA 0003', tareKg: 12_000, plan: [{ orderLineId: line.id, plannedKg: 8_000 }], allocations: [{ orderLineId: line.id, netKg: 8_100 }] },
      START,
    );
    const q = orderMath(s).lineQty(line);
    expect(q).toEqual({ orderedKg: 24_000, dispatchedKg: 8_100, closedKg: 0, reservedKg: 5_000 });
  });

  it('nextNumber restarts each financial year (1 Apr IST)', () => {
    const s = seedState(createFakeClock(START));
    expect(nextNumber(s, tenant, 'order', '2027-03-31T18:20:00Z')).toBe(1);
    expect(nextNumber(s, tenant, 'order', '2027-03-31T18:25:00Z')).toBe(2);
    expect(nextNumber(s, tenant, 'order', '2027-03-31T18:40:00Z')).toBe(1);
  });
});

describe('createMockApi seedOrders and snapshots', () => {
  it('the app opts into demo orders; the default does not', async () => {
    const clock = createFakeClock(START);
    const withDemo = await createMockApi({ clock, seedOrders: true });
    const plain = await createMockApi({ clock });
    expect((await withDemo.controls.stats()).orders).toBe(5);
    expect((await plain.controls.stats()).orders).toBe(0);
  });

  it('a v1 snapshot (from F1) is replaced by the fresh v2 seed', async () => {
    const storage = createMemoryStorage({ 'tonnage.mockState': JSON.stringify({ schemaVersion: 1, users: [] }) });
    const api = await createMockApi({ clock: createFakeClock(START), storage, seedOrders: true });
    expect((await api.controls.stats()).orders).toBe(5);
  });

  it('Reset demo data brings the demo orders back', async () => {
    const clock = createFakeClock(START);
    const api = await createMockApi({ clock, seedOrders: true });
    clock.advance(3 * DAY);
    await api.controls.reset();
    expect((await api.controls.stats()).orders).toBe(5);
  });

  it('controls.addTruck adds a truck the order maths can see; an unknown sub-order is refused', async () => {
    const api = await createMockApi({ clock: createFakeClock(START), seedOrders: true });
    await expect(
      api.controls.addTruck({ subOrderId: SAMPLE_MASTERS.ids.products.tmt12, state: 'assigned', vehicleNo: 'X', plan: [] }),
    ).rejects.toThrow(/sub-order/i);
    expect((await api.controls.stats()).trucks).toBe(8);
  });
});
