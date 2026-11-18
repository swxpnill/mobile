import type { Task, TasksPage } from '@tonnage/shared';
import type { DeviceStore, OutboxRow } from './deviceStore';

/**
 * The behaviour every `DeviceStore` must have, written without jest so the same cases can run
 * against the memory store in jest and against SQLite on a phone (plan Ruling 6). Each case throws
 * on the first mismatch.
 */
export interface DeviceStoreCase {
  name: string;
  run(makeStore: MakeStore): Promise<void>;
}

/** A fresh, empty store whose clock is `clock.now()`. */
export type MakeStore = (clock: { now(): number }) => Promise<DeviceStore>;

const T0 = Date.UTC(2026, 10, 13, 6, 0);
export const TRUCK_A = '0190a000-0000-7000-8000-00000000000a';
export const TRUCK_B = '0190a000-0000-7000-8000-00000000000b';
const TRUCK_C = '0190a000-0000-7000-8000-00000000000c';
const LINE = '0190a000-0000-7000-8000-0000000000f1';

let seq = 0;
/** A fresh event id (uuid shape). */
export function eventId(): string {
  seq += 1;
  return `0190b000-0000-7000-8000-${seq.toString(16).padStart(12, '0')}`;
}

export function task(truckId: string, over: Partial<Task> = {}): Task {
  return {
    truckId,
    vehicleNo: `CG04 AB ${truckId.slice(-4)}`,
    transporterName: null,
    driverName: 'Driver',
    driverPhone: '9826100099',
    customerName: 'Customer',
    subOrderNumber: 'SO-1',
    companyCode: 'AG',
    state: 'assigned',
    tareKg: null,
    tareAt: null,
    tareDeviceId: null,
    plan: [{ orderLineId: LINE, productName: 'TMT 12', plannedKg: 20_000 }],
    version: 1,
    changedAt: new Date(T0).toISOString(),
    ...over,
  };
}

export function page(
  items: Task[],
  removed: string[] = [],
  cursor = new Date(T0).toISOString(),
): TasksPage {
  return { items, removed, resolved: [], deleted: [], cursor, serverTime: cursor };
}

type Capture = Parameters<DeviceStore['saveCapture']>[0];
export const atGate = (truckId: string): Capture => ({
  eventId: eventId(),
  truckId,
  type: 'AT_GATE',
  payload: {},
  capturedAtDevice: new Date(T0).toISOString(),
});
export const tare = (truckId: string, tareKg = 12_000): Capture => ({
  eventId: eventId(),
  truckId,
  type: 'TARE',
  payload: { tareKg },
  capturedAtDevice: new Date(T0).toISOString(),
});
export const gross = (truckId: string, grossKg = 32_000, netKg = 20_000): Capture => ({
  eventId: eventId(),
  truckId,
  type: 'GROSS',
  payload: { grossKg, allocations: [{ orderLineId: LINE, netKg }] },
  capturedAtDevice: new Date(T0).toISOString(),
});

function fail(label: string, actual: unknown, expected: unknown): never {
  throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function eq(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(label, actual, expected);
}
async function rejects(work: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
  throw new Error(`${label}: expected an error`);
}
const pick = (rows: OutboxRow[]) => rows.map((r) => [r.deviceSeq, r.status]);

/** A store with trucks A, B and C on the phone. */
async function seeded(makeStore: MakeStore, clock = { now: () => T0 }): Promise<DeviceStore> {
  const store = await makeStore(clock);
  await store.replaceTasks(page([task(TRUCK_A), task(TRUCK_B), task(TRUCK_C)]));
  return store;
}

export const deviceStoreContract: DeviceStoreCase[] = [
  {
    name: 'saveCapture numbers events 0, 1, 2 and stores them pending',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const rows = [
        await store.saveCapture(atGate(TRUCK_A)),
        await store.saveCapture(tare(TRUCK_A)),
        await store.saveCapture(gross(TRUCK_A)),
      ];
      eq(
        rows.map((r) => r.deviceSeq),
        [0, 1, 2],
        'deviceSeq',
      );
      eq(
        rows.map((r) => [r.status, r.attempts, r.error, r.acceptedAt]),
        Array(3).fill(['pending', 0, null, null]),
        'new rows',
      );
      eq((await store.meta()).nextDeviceSeq, 3, 'nextDeviceSeq');
      eq(await store.outbox(), rows, 'outbox');
    },
  },
  {
    name: 'a failed save (truck not on this phone) leaves no row and no gap in deviceSeq',
    async run(makeStore) {
      const store = await seeded(makeStore);
      await store.saveCapture(atGate(TRUCK_A));
      await rejects(
        () => store.saveCapture(tare('0190a000-0000-7000-8000-0000000000ff')),
        'unknown truck',
      );
      eq(
        (await store.outbox()).map((r) => r.truckId),
        [TRUCK_A],
        'rows',
      );
      eq((await store.meta()).nextDeviceSeq, 1, 'nextDeviceSeq');
      eq((await store.saveCapture(atGate(TRUCK_B))).deviceSeq, 1, 'next seq');
    },
  },
  {
    name: 'saveCapture with a task (owner, Ruling 4) stores the truck with the event in one transaction',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const fresh = '0190a000-0000-7000-8000-0000000000fe';
      const row = await store.saveCapture(tare(fresh), { task: task(fresh) });
      eq(row.status, 'pending', 'status');
      eq((await store.getTasks()).map((t) => t.truckId), [TRUCK_A, TRUCK_B, TRUCK_C, fresh], 'tasks');
      // An older copy never overwrites a newer one already on the phone.
      await store.replaceTasks(page([task(TRUCK_A, { version: 3, driverName: 'New' })], [], new Date(T0 + 1).toISOString()));
      await store.saveCapture(atGate(TRUCK_A), { task: task(TRUCK_A, { version: 2, driverName: 'Old' }) });
      eq((await store.getTasks()).find((t) => t.truckId === TRUCK_A)?.driverName, 'New', 'kept newer');
      // A refused save stores neither the event nor the task.
      const other = '0190a000-0000-7000-8000-0000000000fd';
      await rejects(
        () => store.saveCapture({ ...tare(other, 0.5) }, { task: task(other) }),
        'bad weight',
      );
      eq((await store.getTasks()).some((t) => t.truckId === other), false, 'no task');
    },
  },
  {
    name: 'saving the same event id twice fails inside the transaction and gives back its deviceSeq',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const first = atGate(TRUCK_A);
      await store.saveCapture(first);
      await rejects(
        () => store.saveCapture({ ...atGate(TRUCK_B), eventId: first.eventId }),
        'duplicate id',
      );
      eq(
        (await store.outbox()).map((r) => [r.truckId, r.deviceSeq]),
        [[TRUCK_A, 0]],
        'rows',
      );
      eq((await store.meta()).nextDeviceSeq, 1, 'nextDeviceSeq');
    },
  },
  {
    name: 'saveCapture refuses a weight that is not whole kg or a payload missing its weight',
    async run(makeStore) {
      const store = await seeded(makeStore);
      await rejects(() => store.saveCapture(tare(TRUCK_A, 12_000.5)), 'fractional kg');
      await rejects(() => store.saveCapture({ ...tare(TRUCK_A), payload: {} }), 'missing tare');
      await rejects(
        () => store.saveCapture({ ...gross(TRUCK_A), payload: { grossKg: 30_000 } }),
        'missing allocations',
      );
      eq((await store.outbox()).length, 0, 'rows');
      eq((await store.meta()).nextDeviceSeq, 0, 'nextDeviceSeq');
    },
  },
  {
    name: 'outbox filters by status and lists oldest deviceSeq first',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const a = await store.saveCapture(atGate(TRUCK_A));
      const b = await store.saveCapture(atGate(TRUCK_B));
      await store.saveCapture(atGate(TRUCK_C));
      await store.markSending([b.eventId]);
      eq(
        pick(await store.outbox()),
        [
          [0, 'pending'],
          [1, 'sending'],
          [2, 'pending'],
        ],
        'all',
      );
      eq(
        pick(await store.outbox({ status: ['pending'] })),
        [
          [0, 'pending'],
          [2, 'pending'],
        ],
        'pending',
      );
      eq(
        pick(await store.outbox({ status: ['sending', 'accepted'] })),
        [[1, 'sending']],
        'sending',
      );
      eq(a.status, 'pending', 'returned row unchanged');
    },
  },
  {
    name: 'markResults: accepted and duplicate become accepted; a rejection blocks later rows of that truck only',
    async run(makeStore) {
      const now = { t: T0 + 5_000 };
      const store = await seeded(makeStore, { now: () => now.t });
      const gateA = await store.saveCapture(atGate(TRUCK_A));
      const tareA = await store.saveCapture(tare(TRUCK_A));
      const tareB = await store.saveCapture(tare(TRUCK_B));
      const grossA = await store.saveCapture(gross(TRUCK_A));
      const grossB = await store.saveCapture(gross(TRUCK_B));
      await store.markResults([
        {
          status: 'accepted',
          eventId: gateA.eventId,
          task: task(TRUCK_A, { state: 'at_gate', version: 2 }),
        },
        {
          status: 'rejected',
          eventId: tareA.eventId,
          code: 'TRUCK_CANCELLED',
          message: 'Truck was cancelled',
        },
        { status: 'duplicate', eventId: tareB.eventId },
      ]);
      const rows = await store.outbox();
      eq(
        pick(rows),
        [
          [0, 'accepted'],
          [1, 'rejected'],
          [2, 'accepted'],
          [3, 'blocked'],
          [4, 'pending'],
        ],
        'statuses',
      );
      eq(rows[0]?.acceptedAt, new Date(now.t).toISOString(), 'acceptedAt');
      eq(rows[2]?.acceptedAt, new Date(now.t).toISOString(), 'duplicate acceptedAt');
      eq(rows[1]?.error, { code: 'TRUCK_CANCELLED', message: 'Truck was cancelled' }, 'error');
      eq(rows[3]?.eventId, grossA.eventId, 'blocked row');
      eq(rows[4]?.eventId, grossB.eventId, 'other truck');
    },
  },
  {
    name: 'an accepted result replaces its task; a null task (dispatched) removes it',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const g = await store.saveCapture(atGate(TRUCK_A));
      const d = await store.saveCapture(gross(TRUCK_B));
      await store.markResults([
        {
          status: 'accepted',
          eventId: g.eventId,
          task: task(TRUCK_A, { state: 'at_gate', version: 2 }),
        },
        { status: 'accepted', eventId: d.eventId, task: null, loadingSlipNo: 'LS-1' },
      ]);
      const tasks = await store.getTasks();
      eq(
        tasks.map((t) => [t.truckId, t.state, t.version]),
        [
          [TRUCK_A, 'at_gate', 2],
          [TRUCK_C, 'assigned', 1],
        ],
        'tasks',
      );
    },
  },
  {
    name: 'a new capture for a truck with a rejected event is saved blocked',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const t = await store.saveCapture(tare(TRUCK_A));
      await store.markResults([
        { status: 'rejected', eventId: t.eventId, code: 'TRUCK_CANCELLED', message: 'x' },
      ]);
      eq((await store.saveCapture(gross(TRUCK_A))).status, 'blocked', 'same truck');
      eq((await store.saveCapture(tare(TRUCK_B))).status, 'pending', 'other truck');
    },
  },
  {
    name: 'replaceTasks: resolved event ids end their refused and held rows; a truck with none left takes new captures pending',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const t = await store.saveCapture(tare(TRUCK_A));
      const g = await store.saveCapture(gross(TRUCK_A));
      const b = await store.saveCapture(tare(TRUCK_B));
      await store.markResults([
        { status: 'rejected', eventId: t.eventId, code: 'TRUCK_CANCELLED', message: 'x' },
      ]);
      const cursor = (await store.meta()).cursor ?? new Date(T0).toISOString();
      // Only the tare resolved so far: the held gross still holds the truck.
      await store.replaceTasks({ ...page([], [], cursor), resolved: [t.eventId, b.eventId] });
      eq(
        (await store.outbox()).map((r) => r.status),
        ['resolved', 'blocked', 'pending'],
        'tare resolved, gross held, pending row untouched',
      );
      eq((await store.saveCapture(atGate(TRUCK_A))).status, 'blocked', 'still held');
      const rows = await store.outbox({ status: ['blocked'] });
      await store.replaceTasks({ ...page([], [], cursor), resolved: rows.map((r) => r.eventId) });
      eq((await store.outbox({ status: ['resolved'] })).length, 3, 'all three resolved');
      eq((await store.saveCapture(tare(TRUCK_A))).status, 'pending', 'no longer held');
      eq(g.status, 'pending', 'saved pending before the refusal');
    },
  },
  {
    name: 'replaceTasks: deleted trucks (order erased) resolve every waiting row; a sending row is left alone',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const waiting = await store.saveCapture(atGate(TRUCK_A));
      const inFlight = await store.saveCapture(atGate(TRUCK_A));
      await store.markSending([inFlight.eventId]);
      const t = await store.saveCapture(tare(TRUCK_A));
      const g = await store.saveCapture(gross(TRUCK_A));
      const other = await store.saveCapture(tare(TRUCK_B));
      await store.markResults([
        { status: 'rejected', eventId: t.eventId, code: 'TRUCK_CANCELLED', message: 'x' },
      ]);
      const status = async () => new Map((await store.outbox()).map((r) => [r.eventId, r.status]));
      let st = await status();
      eq([st.get(t.eventId), st.get(g.eventId)], ['rejected', 'blocked'], 'refused and held before');
      const cursor = (await store.meta()).cursor ?? new Date(T0).toISOString();
      await store.replaceTasks({ ...page([], [TRUCK_A], cursor), deleted: [TRUCK_A] });
      st = await status();
      eq(
        [waiting, inFlight, t, g, other].map((r) => st.get(r.eventId)),
        ['resolved', 'sending', 'resolved', 'resolved', 'pending'],
        'truck A settled except the row in flight; truck B untouched',
      );
      eq(
        (await store.outbox({ status: ['pending'] })).filter((r) => r.truckId === TRUCK_A).length,
        0,
        'nothing of truck A pending',
      );
      eq((await store.getTasks()).map((x) => x.truckId), [TRUCK_B, TRUCK_C], 'task gone');
    },
  },
  {
    name: 'requeue puts rows back to pending with one more attempt',
    async run(makeStore) {
      const store = await seeded(makeStore);
      const a = await store.saveCapture(atGate(TRUCK_A));
      const b = await store.saveCapture(atGate(TRUCK_B));
      await store.markSending([a.eventId, b.eventId]);
      await store.requeue([a.eventId]);
      const rows = await store.outbox();
      eq(
        rows.map((r) => [r.status, r.attempts]),
        [
          ['pending', 1],
          ['sending', 0],
        ],
        'rows',
      );
    },
  },
  {
    name: 'replaceTasks: without a cursor a snapshot, with one an upsert plus removals; repeats are harmless',
    async run(makeStore) {
      const store = await makeStore({ now: () => T0 });
      await store.replaceTasks(
        page([task(TRUCK_A), task(TRUCK_B)], [], '2026-11-13T06:00:00.000Z'),
      );
      eq((await store.meta()).cursor, '2026-11-13T06:00:00.000Z', 'cursor stored');
      const next = page(
        [task(TRUCK_B, { state: 'at_gate', version: 2 }), task(TRUCK_C)],
        [TRUCK_A],
        '2026-11-13T06:05:00.000Z',
      );
      await store.replaceTasks(next);
      await store.replaceTasks(next);
      eq(
        (await store.getTasks()).map((t) => [t.truckId, t.state]),
        [
          [TRUCK_B, 'at_gate'],
          [TRUCK_C, 'assigned'],
        ],
        'upserted',
      );
      eq((await store.meta()).cursor, '2026-11-13T06:05:00.000Z', 'cursor moved');
      await store.setMeta({ cursor: null });
      await store.replaceTasks(page([task(TRUCK_A)]));
      eq(
        (await store.getTasks()).map((t) => t.truckId),
        [TRUCK_A],
        'snapshot replaces all',
      );
    },
  },
  {
    name: 'purgeAccepted removes accepted rows older than the limit and nothing else',
    async run(makeStore) {
      const now = { t: T0 };
      const store = await seeded(makeStore, { now: () => now.t });
      const a = await store.saveCapture(atGate(TRUCK_A));
      const b = await store.saveCapture(atGate(TRUCK_B));
      await store.saveCapture(atGate(TRUCK_C));
      await store.markResults([{ status: 'accepted', eventId: a.eventId, task: null }]);
      now.t = T0 + 60_000;
      await store.markResults([{ status: 'accepted', eventId: b.eventId, task: null }]);
      eq(await store.purgeAccepted(60_000, T0 + 90_000), 1, 'purged');
      eq(
        pick(await store.outbox()),
        [
          [1, 'accepted'],
          [2, 'pending'],
        ],
        'left',
      );
    },
  },
  {
    name: 'setMeta racing saveCapture never moves deviceSeq back: the next save still succeeds',
    async run(makeStore) {
      const store = await seeded(makeStore);
      await store.saveCapture(atGate(TRUCK_A));
      // The engine writes meta after every push and pull while the supervisor keeps saving.
      const writing = store.setMeta({
        clockOffsetMs: 1_000,
        lastSyncAt: new Date(T0).toISOString(),
      });
      const second = await store.saveCapture(atGate(TRUCK_B));
      await writing;
      await store.setMeta({ cursor: '2026-11-13T06:00:00.000Z' });
      const third = await store.saveCapture(atGate(TRUCK_C));
      eq([second.deviceSeq, third.deviceSeq], [1, 2], 'deviceSeq');
      eq((await store.meta()).nextDeviceSeq, 3, 'nextDeviceSeq');
      eq((await store.outbox()).length, 3, 'rows');
      // Only saveCapture moves the counter and nothing changes the device id.
      void (() =>
        store.setMeta({
          // @ts-expect-error nextDeviceSeq is owned by saveCapture
          nextDeviceSeq: 0,
        }));
      void (() =>
        store.setMeta({
          // @ts-expect-error deviceId is made once per store
          deviceId: 'x',
        }));
    },
  },
  {
    name: 'meta: a stable device id, partial updates',
    async run(makeStore) {
      const store = await makeStore({ now: () => T0 });
      const m = await store.meta();
      eq(
        [m.cursor, m.clockOffsetMs, m.lastSyncAt, m.nextDeviceSeq],
        [null, 0, null, 0],
        'defaults',
      );
      if (!/^[0-9a-f-]{36}$/.test(m.deviceId)) fail('deviceId', m.deviceId, 'a uuid');
      await store.setMeta({ clockOffsetMs: 600_000, lastSyncAt: '2026-11-13T06:00:00.000Z' });
      const n = await store.meta();
      eq(
        [n.deviceId, n.clockOffsetMs, n.lastSyncAt, n.cursor],
        [m.deviceId, 600_000, '2026-11-13T06:00:00.000Z', null],
        'updated',
      );
    },
  },
  {
    name: 'done today round-trips',
    async run(makeStore) {
      const store = await makeStore({ now: () => T0 });
      eq(await store.getDoneToday(), null, 'empty');
      const d = {
        items: [
          {
            truckId: TRUCK_A,
            vehicleNo: 'CG04 AB 1',
            customerName: null,
            subOrderNumber: 'SO-1',
            netKg: 20_000,
            loadingSlipNo: 'LS-1',
            dispatchedAt: new Date(T0).toISOString(),
          },
        ],
        totalNetKg: 20_000,
      };
      await store.setDoneToday(d);
      eq(await store.getDoneToday(), d, 'stored');
    },
  },
  {
    name: 'clear empties tasks, outbox and done today but keeps the device id and deviceSeq',
    async run(makeStore) {
      const store = await seeded(makeStore);
      await store.saveCapture(atGate(TRUCK_A));
      await store.setDoneToday({ items: [], totalNetKg: 0 });
      const { deviceId } = await store.meta();
      await store.clear();
      eq(
        [await store.getTasks(), await store.outbox(), await store.getDoneToday()],
        [[], [], null],
        'empty',
      );
      const m = await store.meta();
      eq([m.deviceId, m.nextDeviceSeq, m.cursor], [deviceId, 1, null], 'meta');
    },
  },
];
