import { describe, expect, it } from 'vitest';
import {
  SAMPLE_MASTERS,
  SAMPLE_WORLD,
  type SyncEvent,
  plantScope,
  taskSchema,
  truckEarning,
  truckSchema,
} from '@tonnage/shared';
import { createFakeClock, MINUTE, toIso } from './clock.ts';
import { applyEvent, reverseEarning, writeEarning } from './dispatch.ts';
import { createMockApi } from './index.ts';
import { orderCtx } from './order-views.ts';
import { orderMath } from './orders-math.ts';
import { seedDemoOrders } from './seed-orders.ts';
import { type MockState, type TruckRec, createMemoryStorage, seedState } from './store.ts';
import { toTask, toTruck } from './truck-views.ts';
import { addTruck } from './trucks.ts';
import { type Authed, newId } from './views.ts';

const NOW = Date.UTC(2026, 10, 3, 4, 30); // 3 Nov 2026, 10:00 IST
const U = SAMPLE_WORLD.ids.users;
const PHONE = 'phone-of-ravi-0001';

function world(): MockState {
  const clock = createFakeClock(NOW);
  const s = seedState(clock);
  seedDemoOrders(s, clock);
  return s;
}

function authedAs(s: MockState, userId: string): Authed {
  const user = s.users.find((u) => u.id === userId)!;
  return { user, scope: plantScope(user), tenant: s.tenants.find((t) => t.id === user.tenantId)! };
}

const ctxFor = (s: MockState, userId: string, deviceId = PHONE, offsetMs = 0) => ({
  user: authedAs(s, userId),
  deviceId,
  now: NOW,
  offsetMs,
});

const truckBy = (s: MockState, vehicleNo: string): TruckRec => {
  const t = s.trucks.find((x) => x.vehicleNo === vehicleNo && x.state !== 'cancelled');
  if (!t) throw new Error(`no truck ${vehicleNo}`);
  return t;
};

const at = (ms = NOW - 2 * MINUTE) => toIso(ms);
const tare = (truckId: string, tareKg: number): SyncEvent => ({
  eventId: newId(),
  truckId,
  deviceSeq: 1,
  capturedAtDevice: at(),
  type: 'TARE',
  tareKg,
});
const gross = (truckId: string, grossKg: number, allocations: { orderLineId: string; netKg: number }[]): SyncEvent => ({
  eventId: newId(),
  truckId,
  deviceSeq: 2,
  capturedAtDevice: at(),
  type: 'GROSS',
  grossKg,
  allocations,
});
const atGate = (truckId: string): SyncEvent => ({
  eventId: newId(),
  truckId,
  deviceSeq: 0,
  capturedAtDevice: at(),
  type: 'AT_GATE',
});

const linesOf = (s: MockState, t: TruckRec) =>
  new Map(s.orderLines.filter((l) => l.subOrderId === t.subOrderId).map((l) => [l.id, l]));

describe('applyEvent: TARE then GROSS on the seeded loading truck (Siltara, CG 04 MK 2291)', () => {
  it('dispatches it: weighments, allocations, slip number, one broker earning, activity', () => {
    const s = world();
    const truck = truckBy(s, 'CG 04 MK 2291');
    expect(truck.state).toBe('loading');
    expect(truck.tareKg).toBe(12_460);
    const line = truck.plan[0]!.orderLineId;
    const ctx = ctxFor(s, U.ravi, truck.tareDeviceId!);

    const t1 = applyEvent(s, ctx, tare(truck.id, 12_460));
    expect(t1).toMatchObject({ status: 'accepted', task: { truckId: truck.id, state: 'loading', tareKg: 12_460 } });

    const g = gross(truck.id, 36_640, [{ orderLineId: line, netKg: 24_180 }]);
    const r = applyEvent(s, ctx, g);
    expect(r.status).toBe('accepted');
    if (r.status !== 'accepted') return;
    expect(r.task).toBeNull();
    expect(r.loadingSlipNo).toMatch(/^LS-AIP-2611-000\d$/);

    expect(truck).toMatchObject({
      state: 'dispatched',
      tareKg: 12_460,
      grossKg: 36_640,
      allocations: [{ orderLineId: line, netKg: 24_180 }],
      loadingSlipNo: r.loadingSlipNo,
      dispatchedAt: g.capturedAtDevice,
    });

    // The corrected tare superseded the seeded one; one live tare, one gross.
    const w = s.weighments.filter((x) => x.truckId === truck.id);
    expect(w.filter((x) => x.kind === 'tare' && x.supersededBy === null)).toHaveLength(1);
    expect(w.filter((x) => x.kind === 'tare' && x.supersededBy !== null)).toHaveLength(1);
    expect(w.filter((x) => x.kind === 'gross')).toMatchObject([
      { kg: 36_640, enteredBy: U.ravi, deviceId: ctx.deviceId, clientEventId: g.eventId, clockSkewFlag: false },
    ]);

    const order = s.orders.find((o) => o.id === truck.orderId)!;
    const expected = truckEarning(truck.allocations, linesOf(s, truck), order.commissionPerMtSnapshot!);
    expect(expected.earningRupees).toBe(10_881); // 24.180 MT × (₹150 + ₹300)
    const ledger = s.brokerLedger.filter((x) => x.truckId === truck.id);
    expect(ledger).toEqual([
      expect.objectContaining({
        kind: 'earning',
        brokerId: order.brokerId,
        amountRupees: expected.earningRupees,
        breakdown: expected.breakdown,
        reversesId: null,
        createdBy: U.ravi,
      }),
    ]);

    const acts = s.activity.filter((e) => e.entityType === 'order' && e.entityId === order.id).map((e) => e.action);
    expect(acts).toEqual(['truck.tare_corrected', 'truck.dispatched']);
    const dispatched = s.activity.find((e) => e.action === 'truck.dispatched')!;
    expect(dispatched.meta).toMatchObject({
      subOrderId: truck.subOrderId,
      vehicleNo: 'CG 04 MK 2291',
      netKg: 24_180,
      loadingSlipNo: r.loadingSlipNo,
    });

    // The owner's order now counts 24,180 kg dispatched on that line.
    expect(orderMath(s).lineQty(s.orderLines.find((l) => l.id === line)!).dispatchedKg).toBe(24_180);
  });

  it('a GROSS whose net is 0 is rejected INVALID_WEIGHT and nothing changes', () => {
    const s = world();
    const truck = truckBy(s, 'CG 04 MK 2291');
    const before = JSON.stringify({ t: truck, w: s.weighments, l: s.brokerLedger, n: s.numberSeries });
    const r = applyEvent(s, ctxFor(s, U.ravi), gross(truck.id, 12_460, [{ orderLineId: truck.plan[0]!.orderLineId, netKg: 0 }]));
    expect(r).toMatchObject({ status: 'rejected', code: 'INVALID_WEIGHT', message: expect.any(String) });
    expect(JSON.stringify({ t: truck, w: s.weighments, l: s.brokerLedger, n: s.numberSeries })).toBe(before);
  });

  it('a replay of the same event (accepted or rejected) is a duplicate and changes nothing', () => {
    const s = world();
    const truck = truckBy(s, 'CG 07 KL 3304');
    const ev = atGate(truck.id);
    expect(applyEvent(s, ctxFor(s, U.ravi), ev).status).toBe('accepted');
    const bad = gross(truck.id, 30_000, [{ orderLineId: truck.plan[0]!.orderLineId, netKg: 1 }]);
    expect(applyEvent(s, ctxFor(s, U.ravi), bad)).toMatchObject({ status: 'rejected', code: 'TARE_REQUIRED' });
    const snapshot = JSON.stringify(s);
    expect(applyEvent(s, ctxFor(s, U.ravi), ev)).toEqual({ status: 'duplicate', eventId: ev.eventId });
    expect(applyEvent(s, ctxFor(s, U.ravi), bad)).toEqual({ status: 'duplicate', eventId: bad.eventId });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('applyEvent: the §6.5 table', () => {
  it('Sanjay (Borai) cannot weigh a Siltara truck; an unknown truck is PLANT_SCOPE too', () => {
    const s = world();
    const truck = truckBy(s, 'CG 07 KL 3304');
    expect(applyEvent(s, ctxFor(s, U.sanjay), atGate(truck.id))).toMatchObject({ status: 'rejected', code: 'PLANT_SCOPE' });
    expect(applyEvent(s, ctxFor(s, U.ravi), atGate(newId()))).toMatchObject({ status: 'rejected', code: 'PLANT_SCOPE' });
    // The owner has every plant.
    expect(applyEvent(s, ctxFor(s, U.rajesh), atGate(truck.id)).status).toBe('accepted');
  });

  it('AT_GATE: assigned → at gate; late on at gate or loading is a no-op; dispatched is refused', () => {
    const s = world();
    const assigned = truckBy(s, 'CG 10 GH 4471');
    const r = applyEvent(s, ctxFor(s, U.ravi), atGate(assigned.id));
    expect(r).toMatchObject({ status: 'accepted', task: { state: 'at_gate' } });
    expect(assigned.atGateAt).not.toBeNull();
    expect(assigned.version).toBe(2);
    const loading = truckBy(s, 'CG 04 MK 2291');
    const v = loading.version;
    expect(applyEvent(s, ctxFor(s, U.ravi), atGate(loading.id))).toMatchObject({ status: 'accepted', task: { state: 'loading' } });
    expect(loading.state).toBe('loading');
    expect(loading.version).toBe(v);
    const done = truckBy(s, 'CG 04 AB 1123');
    expect(applyEvent(s, ctxFor(s, U.sanjay), atGate(done.id))).toMatchObject({
      status: 'rejected',
      code: 'ALREADY_DISPATCHED',
      server: { state: 'dispatched' },
    });
  });

  it('TARE from another device on a tared truck is TARE_CONFLICT with the winning value', () => {
    const s = world();
    const truck = truckBy(s, 'CG 07 KL 3304');
    const first = tare(truck.id, 11_980);
    expect(applyEvent(s, ctxFor(s, U.ravi, 'phone-a-00000001'), first).status).toBe('accepted');
    expect(truck).toMatchObject({ state: 'loading', tareKg: 11_980, tareDeviceId: 'phone-a-00000001' });
    const r = applyEvent(s, ctxFor(s, U.rajesh, 'phone-b-00000002'), tare(truck.id, 12_100));
    expect(r).toMatchObject({
      status: 'rejected',
      code: 'TARE_CONFLICT',
      server: { tareKg: 11_980, by: 'Ravi Verma', at: truck.tareAt, state: 'loading' },
    });
    expect(truck.tareKg).toBe(11_980);
  });

  it('a cancelled truck is TRUCK_CANCELLED; GROSS on a truck at the gate is TARE_REQUIRED', () => {
    const s = world();
    const truck = truckBy(s, 'CG 07 KL 3304');
    const line = truck.plan[0]!.orderLineId;
    expect(applyEvent(s, ctxFor(s, U.ravi), gross(truck.id, 30_000, [{ orderLineId: line, netKg: 18_000 }]))).toMatchObject({
      status: 'rejected',
      code: 'TARE_REQUIRED',
    });
    truck.state = 'cancelled';
    expect(applyEvent(s, ctxFor(s, U.ravi), tare(truck.id, 12_000))).toMatchObject({
      status: 'rejected',
      code: 'TRUCK_CANCELLED',
      server: { state: 'cancelled' },
    });
  });

  it('allocation off by 1 kg is ALLOC_MISMATCH; a line not on the sub-order is LINE_REMOVED', () => {
    const s = world();
    const truck = truckBy(s, 'CG 04 MK 2291');
    const line = truck.plan[0]!.orderLineId;
    expect(applyEvent(s, ctxFor(s, U.ravi), gross(truck.id, 36_640, [{ orderLineId: line, netKg: 24_179 }]))).toMatchObject({
      code: 'ALLOC_MISMATCH',
    });
    expect(applyEvent(s, ctxFor(s, U.ravi), gross(truck.id, 36_640, [{ orderLineId: newId(), netKg: 24_180 }]))).toMatchObject({
      code: 'LINE_REMOVED',
    });
    expect(truck.state).toBe('loading');
  });

  it('a gate clock 10 min slow: business time is corrected and the skew is flagged', () => {
    const s = world();
    const truck = truckBy(s, 'CG 07 KL 3304');
    const ev = tare(truck.id, 12_000);
    applyEvent(s, ctxFor(s, U.ravi, PHONE, 10 * MINUTE), ev);
    const w = s.weighments.find((x) => x.clientEventId === ev.eventId)!;
    expect(w).toMatchObject({
      capturedAtDevice: ev.capturedAtDevice,
      capturedAt: toIso(Date.parse(ev.capturedAtDevice) + 10 * MINUTE),
      receivedAt: toIso(NOW),
      clockSkewFlag: true,
    });
    expect(truck.tareAt).toBe(w.capturedAt);
  });
});

describe('applyEvent: tolerance close and over-tolerance', () => {
  /** 142-A with the gate and assigned trucks dispatched by fixtures: 12 mm · 6 m done, 16 mm short by 400 kg. */
  function nearlyDone(s: MockState) {
    const loading = truckBy(s, 'CG 04 MK 2291');
    const lines = s.orderLines.filter((l) => l.subOrderId === loading.subOrderId);
    for (const vno of ['CG 07 KL 3304', 'CG 10 GH 4471']) truckBy(s, vno).state = 'cancelled';
    addTruck(
      s,
      {
        subOrderId: loading.subOrderId,
        state: 'dispatched',
        vehicleNo: 'CG 04 ZZ 0001',
        tareKg: 12_000,
        plan: [{ orderLineId: lines[1]!.id, plannedKg: 10_000 }, { orderLineId: lines[2]!.id, plannedKg: 20_000 }],
        allocations: [{ orderLineId: lines[1]!.id, netKg: 10_000 }, { orderLineId: lines[2]!.id, netKg: 19_600 }],
      },
      NOW - 30 * MINUTE,
    );
    return { loading, lines, sub: s.subOrders.find((x) => x.id === loading.subOrderId)! };
  }

  it('the last truck leaves 400 kg pending: the sub-order closes within tolerance', () => {
    const s = world();
    const { loading, lines, sub } = nearlyDone(s);
    const r = applyEvent(s, ctxFor(s, U.ravi), gross(loading.id, 36_640, [{ orderLineId: lines[0]!.id, netKg: 24_180 }]));
    expect(r.status).toBe('accepted');
    expect(sub).toMatchObject({ closeKind: 'tolerance', closeReason: 'Within tolerance', closedBy: U.ravi, version: 2 });
    expect(lines.map((l) => l.closedKg)).toEqual([0, 0, 400]);
    expect(orderMath(s).subOrderStatus(sub)).toBe('completed');
    expect(s.activity.some((e) => e.action === 'order.over_tolerance')).toBe(false);
  });

  it('with another truck still open nothing closes', () => {
    const s = world();
    const { loading, lines, sub } = nearlyDone(s);
    s.trucks.find((t) => t.vehicleNo === 'CG 10 GH 4471')!.state = 'assigned';
    applyEvent(s, ctxFor(s, U.ravi), gross(loading.id, 36_640, [{ orderLineId: lines[0]!.id, netKg: 24_180 }]));
    expect(sub.closeKind).toBeNull();
    expect(lines.map((l) => l.closedKg)).toEqual([0, 0, 0]);
  });

  it('more than 1 MT over the order is logged as over tolerance', () => {
    const s = world();
    const { loading, lines, sub } = nearlyDone(s);
    applyEvent(s, ctxFor(s, U.ravi), gross(loading.id, 38_460, [{ orderLineId: lines[0]!.id, netKg: 26_000 }]));
    expect(s.activity.find((e) => e.action === 'order.over_tolerance')?.meta).toEqual({ subOrderId: sub.id, kg: 2_000 });
  });
});

describe('earnings and views', () => {
  it('reverseEarning negates the latest earning once; a no-broker truck gets no ledger row', () => {
    const s = world();
    const gupta = s.trucks.find((t) => t.vehicleNo === 'CG 04 NB 5510')!;
    const rows = s.brokerLedger.filter((x) => x.truckId === gupta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountRupees).toBe(2_265); // 15.100 MT × ₹150
    reverseEarning(s, gupta, toIso(NOW), U.rajesh);
    reverseEarning(s, gupta, toIso(NOW), U.rajesh);
    const after = s.brokerLedger.filter((x) => x.truckId === gupta.id);
    expect(after.map((x) => [x.kind, x.amountRupees, x.reversesId])).toEqual([
      ['earning', 2_265, null],
      ['reversal', -2_265, rows[0]!.id],
    ]);
    writeEarning(s, gupta, toIso(NOW), U.rajesh);
    expect(s.brokerLedger.filter((x) => x.truckId === gupta.id).reduce((n, x) => n + x.amountRupees, 0)).toBe(2_265);

    const patel = truckBy(s, 'CG 04 AB 1123');
    writeEarning(s, patel, toIso(NOW), U.rajesh);
    expect(s.brokerLedger.some((x) => x.truckId === patel.id)).toBe(false);
  });

  it('toTruck carries the earning only on broker orders; toTask carries no money', () => {
    const s = world();
    const c = orderCtx(s, orderMath(s), authedAs(s, U.rajesh), NOW);
    const gupta = truckSchema.parse(toTruck(c, s.trucks.find((t) => t.vehicleNo === 'CG 04 NB 5510')!, { withWeighments: true }));
    expect(gupta).toMatchObject({ earningRupees: 2_265, netKg: 15_100, state: 'dispatched' });
    expect(gupta.loadingSlipNo).toMatch(/^LS-NAP-\d{4}-0001$/);
    expect(gupta.weighments.map((w) => w.kind)).toEqual(['tare', 'gross']);
    const patel = toTruck(c, truckBy(s, 'CG 04 AB 1123'), { withWeighments: false });
    expect('earningRupees' in patel).toBe(false);
    expect(patel.weighments).toEqual([]);

    const loading = truckBy(s, 'CG 04 MK 2291');
    const full = truckSchema.parse(toTruck(c, loading, { withWeighments: true }));
    expect(full).toMatchObject({
      vehicleNo: 'CG 04 MK 2291',
      transporter: { id: SAMPLE_MASTERS.ids.parties.shreeGanesh, name: 'Shree Ganesh Roadlines' },
      driverName: 'Ramesh Yadav',
      customerName: 'Shubham Traders',
      companyCode: 'AIP',
      plantName: 'Siltara',
      subOrderNumber: 'SO-2611-0142-A',
      earningRupees: 0,
    });
    const task = taskSchema.parse(toTask(s, loading));
    expect(task).toMatchObject({ truckId: loading.id, tareKg: 12_460, state: 'loading', changedAt: loading.updatedAt });
    expect(JSON.stringify(task)).not.toMatch(/rupee|rate|earning|breakdown|value/i);
  });
});

describe('demo seed trucks', () => {
  it('Siltara has one assigned, one at gate and one loading truck; Borai one loading', () => {
    const s = world();
    const byPlant = (p: string) => s.trucks.filter((t) => t.plantId === p && t.state !== 'dispatched').map((t) => t.state).sort();
    expect(byPlant(SAMPLE_WORLD.ids.plants.siltara)).toEqual(['assigned', 'at_gate', 'loading']);
    expect(byPlant(SAMPLE_WORLD.ids.plants.borai)).toEqual(['loading']);
  });

  it('every dispatched truck: gross − tare = Σ allocations = its weighments, a slip, and an earning on broker orders', () => {
    const s = world();
    const dispatched = s.trucks.filter((t) => t.state === 'dispatched');
    expect(dispatched).toHaveLength(7);
    for (const t of dispatched) {
      const net = t.allocations.reduce((n, a) => n + a.netKg, 0);
      expect(t.grossKg! - t.tareKg!).toBe(net);
      const w = s.weighments.filter((x) => x.truckId === t.id);
      expect(w.find((x) => x.kind === 'tare')?.kg).toBe(t.tareKg);
      expect(w.find((x) => x.kind === 'gross')?.kg).toBe(t.grossKg);
      expect(t.loadingSlipNo).toMatch(/^LS-(KRM|NAP)-\d{4}-\d{4}$/);
      const order = s.orders.find((o) => o.id === t.orderId)!;
      expect(s.brokerLedger.filter((x) => x.truckId === t.id)).toHaveLength(order.brokerId ? 1 : 0);
    }
    // Slips continue the series: the next KRM slip is the sixth.
    const krm = SAMPLE_WORLD.ids.companies.KRM;
    expect(s.numberSeries.find((r) => r.key === `ls:${krm}`)?.next).toBe(6);
  });
});

describe('snapshot version', () => {
  it('a version 3 snapshot is discarded on load (the seed comes back)', async () => {
    const old = { ...seedState(createFakeClock(NOW)), schemaVersion: 3 };
    const storage = createMemoryStorage({ 'tonnage.mockState': JSON.stringify(old) });
    const api = await createMockApi({ clock: createFakeClock(NOW), storage, seedOrders: true });
    expect(await api.controls.stats()).toMatchObject({ orders: 5, trucks: 11 });
  });
});
