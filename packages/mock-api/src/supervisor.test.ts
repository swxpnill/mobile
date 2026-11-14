import { describe, expect, it } from 'vitest';
import { SAMPLE_WORLD, type SyncEvent, syncResponseSchema } from '@tonnage/shared';
import { MINUTE, createFakeClock, toIso } from './clock.ts';
import { ALL_ROUTES } from './index.ts';
import { createPipeline, runEventTransaction } from './pipeline.ts';
import { buildRouter } from './router.ts';
import { seedDemoOrders } from './seed-orders.ts';
import { issueTokens } from './sessions.ts';
import { type MockState, createMemoryStorage, createStore, seedState } from './store.ts';
import { newId } from './views.ts';

const NOW = Date.UTC(2026, 10, 3, 4, 30); // 3 Nov 2026, 10:00 IST
const U = SAMPLE_WORLD.ids.users;
const PHONE = 'phone-of-ravi-0001';

async function setup() {
  const clock = createFakeClock(NOW);
  const seed = (): MockState => {
    const s = seedState(clock);
    seedDemoOrders(s, clock);
    return s;
  };
  const store = await createStore({ storage: createMemoryStorage(), storageKey: 'k', clock, seed });
  const { handle } = createPipeline({ router: buildRouter(ALL_ROUTES), store, clock });
  let key = 0;
  const sync = async (userId: string, events: SyncEvent[]) => {
    const { accessToken } = issueTokens(store.state, userId, PHONE, clock.now());
    key += 1;
    const res = await handle({
      method: 'POST',
      path: '/v1/weighments/sync',
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': `k-${key}` },
      body: { deviceId: PHONE, events },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return syncResponseSchema.parse(res.body).results;
  };
  const truck = (vehicleNo: string) => {
    const t = store.state.trucks.find((x) => x.vehicleNo === vehicleNo);
    if (!t) throw new Error(`no truck ${vehicleNo}`);
    return t;
  };
  return { store, sync, truck };
}

const base = (truckId: string, deviceSeq: number) => ({
  eventId: newId(),
  truckId,
  deviceSeq,
  capturedAtDevice: toIso(NOW - 2 * MINUTE),
});

describe('weighment sync: rejections for Needs attention', () => {
  it('one open rejection per rejected event, blocked ones included; a replay adds none', async () => {
    const { store, sync, truck } = await setup();
    const t = truck('CG 07 KL 3304'); // Siltara, at gate
    t.state = 'cancelled';
    const line = t.plan[0]!.orderLineId;
    const events: SyncEvent[] = [
      { ...base(t.id, 1), type: 'TARE', tareKg: 12_000 },
      { ...base(t.id, 2), type: 'GROSS', grossKg: 22_000, allocations: [{ orderLineId: line, netKg: 10_000 }] },
    ];
    const results = await sync(U.ravi, events);
    expect(results.map((r) => (r.status === 'rejected' ? r.code : r.status))).toEqual(['TRUCK_CANCELLED', 'INVALID_STATE']);

    const rows = () => store.state.rejections.filter((r) => r.truckId === t.id);
    expect(rows()).toMatchObject([
      { clientEventId: events[0]!.eventId, code: 'TRUCK_CANCELLED', serverState: 'cancelled', status: 'open', userId: U.ravi, deviceId: PHONE, event: events[0] },
      { clientEventId: events[1]!.eventId, code: 'INVALID_STATE', serverState: 'cancelled', status: 'open', event: events[1] },
    ]);
    expect(store.state.appliedEvents[events[1]!.eventId]).toEqual({ truckId: t.id, status: 'rejected' });

    expect((await sync(U.ravi, events)).map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(rows()).toHaveLength(2);
  });

  it('PLANT_SCOPE on another plant’s truck is kept; an unknown truck id leaves no row', async () => {
    const { store, sync, truck } = await setup();
    const siltara = truck('CG 10 GH 4471');
    const before = store.state.rejections.length;
    const results = await sync(U.sanjay, [
      { ...base(siltara.id, 1), type: 'AT_GATE' },
      { ...base(siltara.id, 2), type: 'TARE', tareKg: 12_000 },
      { ...base(newId(), 3), type: 'AT_GATE' },
    ]);
    expect(results.map((r) => (r.status === 'rejected' ? r.code : r.status))).toEqual(['PLANT_SCOPE', 'INVALID_STATE', 'PLANT_SCOPE']);
    // The blocked event does not tell Sanjay what state a Siltara truck is in.
    expect(results[1]).not.toHaveProperty('server');
    expect(store.state.rejections.slice(before)).toMatchObject([
      { truckId: siltara.id, code: 'PLANT_SCOPE', serverState: 'assigned' },
      { truckId: siltara.id, code: 'INVALID_STATE', serverState: 'assigned' },
    ]);
    expect(siltara.state).toBe('assigned');
  });

  it('accepted events leave no rejection', async () => {
    const { store, sync, truck } = await setup();
    const t = truck('CG 10 GH 4471');
    expect((await sync(U.ravi, [{ ...base(t.id, 1), type: 'AT_GATE' }]))[0]!.status).toBe('accepted');
    expect(store.state.rejections).toEqual([]);
  });
});

describe('runEventTransaction', () => {
  it('returns the result and keeps the changes', () => {
    const s = seedState(createFakeClock(NOW));
    const out = runEventTransaction(s, () => {
      s.activity.push({ id: 'a1', tenantId: 't', entityType: 'order', entityId: 'o', action: 'x', actorId: 'u', at: toIso(NOW) });
      return 42;
    });
    expect(out).toBe(42);
    expect(s.activity.map((a) => a.id)).toContain('a1');
  });

  it('undoes every change when the function throws, and rethrows', () => {
    const s = seedState(createFakeClock(NOW));
    const before = JSON.stringify(s);
    expect(() =>
      runEventTransaction(s, () => {
        s.activity.push({ id: 'a1', tenantId: 't', entityType: 'order', entityId: 'o', action: 'x', actorId: 'u', at: toIso(NOW) });
        s.users[0]!.name = 'Changed';
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(JSON.stringify(s)).toBe(before);
  });
});
