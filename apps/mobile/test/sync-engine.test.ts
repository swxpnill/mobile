import {
  type DoneToday,
  type SyncBody,
  type SyncResult,
  type TasksPage,
  NetworkError,
} from '@tonnage/shared';
import { AppState, type AppStateStatus } from 'react-native';
import { ApiError } from '../src/api/client';
import { backoff } from '../src/offline/backoff';
import { type DeviceStore, createMemoryDeviceStore } from '../src/offline/deviceStore';
import {
  TRUCK_A,
  TRUCK_B,
  atGate,
  gross,
  page,
  tare,
  task,
} from '../src/offline/deviceStoreContract';
import { type SyncEngine, type SyncOutcome, createSyncEngine } from '../src/offline/syncEngine';
import { startSyncLoop, useSyncStatus } from '../src/offline/useSync';

const NOW = Date.UTC(2026, 10, 13, 6, 0);
const DONE: DoneToday = { items: [], totalNetKg: 0 };

type Push = (body: SyncBody) => Promise<{ results: SyncResult[]; serverDate: string | null }>;

/** Accepts every event, unless `answer` says otherwise for that event. */
const acceptAll =
  (answer: (eventId: string) => SyncResult | undefined = () => undefined): Push =>
  async (body) => ({
    results: body.events.map(
      (e) => answer(e.eventId) ?? { status: 'accepted', eventId: e.eventId, task: null },
    ),
    serverDate: new Date(NOW).toUTCString(),
  });

let store: DeviceStore;
let pushes: SyncBody[];
let pulls: (string | null)[];
let push: Push;
let pullPage: TasksPage;

function engine() {
  return createSyncEngine({
    store,
    push: (body) => {
      pushes.push(body);
      return push(body);
    },
    pull: async (cursor) => {
      pulls.push(cursor);
      return pullPage;
    },
    pullDoneToday: async () => DONE,
    now: () => NOW,
    random: () => 0.5,
  });
}

beforeEach(async () => {
  store = createMemoryDeviceStore({ now: () => NOW });
  pullPage = page([task(TRUCK_A), task(TRUCK_B)], [], '2026-11-13T06:00:00.000Z');
  await store.replaceTasks(pullPage);
  await store.setMeta({ cursor: null });
  pushes = [];
  pulls = [];
  push = acceptAll();
});

describe('sync engine', () => {
  it('a network error puts rows back to pending with one more attempt; the next run sends them', async () => {
    await store.saveCapture(atGate(TRUCK_A));
    await store.saveCapture(tare(TRUCK_A));
    const statusesInFlight: string[][] = [];
    push = async () => {
      statusesInFlight.push((await store.outbox()).map((r) => r.status));
      throw new NetworkError();
    };

    const failed = await engine().syncNow();

    expect(statusesInFlight).toEqual([['sending', 'sending']]);
    expect(failed).toEqual({ ok: false, sent: 0, rejected: 0, pendingLeft: 2, error: 'network' });
    expect((await store.outbox()).map((r) => [r.status, r.attempts])).toEqual([
      ['pending', 1],
      ['pending', 1],
    ]);
    expect(pulls).toEqual([]); // offline: no pull either

    push = acceptAll();
    const ok = await engine().syncNow();

    expect(ok).toEqual({ ok: true, sent: 2, rejected: 0, pendingLeft: 0 });
    expect((await store.outbox()).map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect(pushes[1]?.events.map((e) => e.deviceSeq)).toEqual([0, 1]);
  });

  it('sends events oldest deviceSeq first, as the shared sync body, then pulls with the stored cursor', async () => {
    await store.saveCapture(atGate(TRUCK_B));
    await store.saveCapture(tare(TRUCK_B, 11_000));
    await store.saveCapture(gross(TRUCK_B, 31_000, 20_000));
    await store.setMeta({ cursor: '2026-11-13T05:00:00.000Z' });

    await engine().syncNow();

    const { deviceId } = await store.meta();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.deviceId).toBe(deviceId);
    expect(pushes[0]?.events.map((e) => ({ ...e, eventId: undefined }))).toEqual([
      {
        eventId: undefined,
        truckId: TRUCK_B,
        deviceSeq: 0,
        capturedAtDevice: expect.any(String),
        type: 'AT_GATE',
      },
      {
        eventId: undefined,
        truckId: TRUCK_B,
        deviceSeq: 1,
        capturedAtDevice: expect.any(String),
        type: 'TARE',
        tareKg: 11_000,
      },
      {
        eventId: undefined,
        truckId: TRUCK_B,
        deviceSeq: 2,
        capturedAtDevice: expect.any(String),
        type: 'GROSS',
        grossKg: 31_000,
        allocations: [{ orderLineId: expect.any(String), netKg: 20_000 }],
      },
    ]);
    expect(pulls).toEqual(['2026-11-13T05:00:00.000Z']);
    expect(await store.getDoneToday()).toEqual(DONE);
    expect((await store.meta()).lastSyncAt).toBe(new Date(NOW).toISOString());
  });

  it('sends at most 100 events per request', async () => {
    for (let i = 0; i < 150; i++) await store.saveCapture(atGate(TRUCK_A));

    const out = await engine().syncNow();

    expect(pushes.map((b) => b.events.length)).toEqual([100, 50]);
    expect(pushes[1]?.events[0]?.deviceSeq).toBe(100);
    expect(out).toMatchObject({ ok: true, sent: 150, pendingLeft: 0 });
  });

  it('a rejected TARE blocks the later GROSS of that truck, which is not sent on its own; another truck still goes', async () => {
    const tareA = await store.saveCapture(tare(TRUCK_A));
    let grossA = '';
    let grossB = '';
    push = async (body) => {
      // Weights captured while the first request is out.
      if (pushes.length === 1) {
        grossA = (await store.saveCapture(gross(TRUCK_A))).eventId;
        grossB = (await store.saveCapture(gross(TRUCK_B))).eventId;
      }
      return acceptAll((id) =>
        id === tareA.eventId
          ? {
              status: 'rejected',
              eventId: id,
              code: 'TRUCK_CANCELLED',
              message: 'Truck was cancelled',
            }
          : undefined,
      )(body);
    };

    const first = await engine().syncNow();

    expect(first).toEqual({ ok: true, sent: 2, rejected: 1, pendingLeft: 0 });
    expect(pushes.flatMap((b) => b.events.map((e) => e.eventId))).toEqual([tareA.eventId, grossB]);
    const rows = await store.outbox();
    expect(rows.map((r) => [r.eventId, r.status])).toEqual([
      [tareA.eventId, 'rejected'],
      [grossA, 'blocked'],
      [grossB, 'accepted'],
    ]);
    expect(rows[0]?.error).toEqual({ code: 'TRUCK_CANCELLED', message: 'Truck was cancelled' });
    // The next run takes the held GROSS to the server behind its refused TARE (see below).
    const second = await engine().syncNow();
    expect(pushes.at(-1)?.events.map((e) => e.eventId)).toEqual([tareA.eventId, grossA]);
    expect(second).toMatchObject({ ok: true, sent: 2, pendingLeft: 0 });
  });

  it('a held GROSS goes behind its refused TARE, sent again; both come back rejected and are not sent again', async () => {
    const tareA = await store.saveCapture(tare(TRUCK_A));
    const cancelled = (id: string): SyncResult => ({
      status: 'rejected',
      eventId: id,
      code: 'TRUCK_CANCELLED',
      message: 'Truck was cancelled',
    });
    push = acceptAll(cancelled);
    await engine().syncNow();
    // Weighed after the refusal: saved held, never sent on its own.
    const grossA = await store.saveCapture(gross(TRUCK_A));
    const atGateB = await store.saveCapture(atGate(TRUCK_B));
    expect(grossA.status).toBe('blocked');
    // The server answers a replayed refusal the same way and blocks the truck's later events.
    push = acceptAll((id) =>
      id === tareA.eventId
        ? cancelled(id)
        : id === grossA.eventId
          ? { status: 'rejected', eventId: id, code: 'INVALID_STATE', message: 'Blocked by an earlier rejected weight' }
          : undefined,
    );

    const out = await engine().syncNow();

    expect(pushes[1]?.events.map((e) => e.eventId)).toEqual([
      tareA.eventId,
      grossA.eventId,
      atGateB.eventId,
    ]);
    expect(out).toMatchObject({ ok: true, pendingLeft: 0 });
    expect((await store.outbox()).map((r) => [r.eventId, r.status])).toEqual([
      [tareA.eventId, 'rejected'],
      [grossA.eventId, 'rejected'],
      [atGateB.eventId, 'accepted'],
    ]);
    expect((await store.outbox())[1]?.error?.code).toBe('INVALID_STATE');

    // Nothing held any more: the next run sends nothing.
    await engine().syncNow();
    expect(pushes).toHaveLength(2);
  });

  it('a resolved pull ends the refused rows: the truck takes new weights pending again', async () => {
    const tareA = await store.saveCapture(tare(TRUCK_A));
    push = acceptAll((id) => ({ status: 'rejected', eventId: id, code: 'TRUCK_CANCELLED', message: 'x' }));
    await engine().syncNow();
    expect((await store.outbox())[0]?.status).toBe('rejected');

    pullPage = { ...page([task(TRUCK_A, { version: 2 })], [], '2026-11-13T06:01:00.000Z'), resolved: [tareA.eventId] };
    await engine().syncNow();

    expect((await store.outbox())[0]?.status).toBe('resolved');
    expect((await store.saveCapture(tare(TRUCK_A, 12_500))).status).toBe('pending');
  });

  it('sends again rows left "sending" by a run that never finished (app killed mid-request)', async () => {
    const row = await store.saveCapture(atGate(TRUCK_A));
    await store.markSending([row.eventId]);

    const out = await engine().syncNow();

    expect(out).toMatchObject({ ok: true, sent: 1, pendingLeft: 0 });
    expect(pushes[0]?.events.map((e) => e.eventId)).toEqual([row.eventId]);
  });

  it('a stale "sending" TARE replayed: duplicate ends accepted; rejected ends rejected and blocks the later GROSS', async () => {
    const done = await store.saveCapture(tare(TRUCK_A));
    await store.markSending([done.eventId]);
    push = acceptAll((id) => ({ status: 'duplicate', eventId: id }));
    expect(await engine().syncNow()).toMatchObject({ ok: true, sent: 1, pendingLeft: 0 });
    expect((await store.outbox())[0]?.status).toBe('accepted');

    // The server had refused it before the crash; the replay is refused the same way.
    const refused = await store.saveCapture(tare(TRUCK_B));
    await store.markSending([refused.eventId]);
    let grossB = '';
    push = async (body) => {
      grossB = (await store.saveCapture(gross(TRUCK_B))).eventId; // weighed while it is out
      return acceptAll(() => ({
        status: 'rejected',
        eventId: refused.eventId,
        code: 'TRUCK_CANCELLED',
        message: 'Truck was cancelled',
      }))(body);
    };

    const out = await engine().syncNow();

    expect(out).toMatchObject({ ok: true, rejected: 1, pendingLeft: 0 });
    const rows = await store.outbox();
    expect(rows.map((r) => [r.eventId, r.status])).toEqual([
      [done.eventId, 'accepted'],
      [refused.eventId, 'rejected'],
      [grossB, 'blocked'],
    ]);
    expect(pushes.flatMap((b) => b.events.map((e) => e.eventId))).not.toContain(grossB);
  });

  it('treats duplicate as accepted', async () => {
    await store.saveCapture(atGate(TRUCK_A));
    push = acceptAll((id) => ({ status: 'duplicate', eventId: id }));

    const out = await engine().syncNow();

    expect(out).toEqual({ ok: true, sent: 1, rejected: 0, pendingLeft: 0 });
    expect((await store.outbox())[0]?.status).toBe('accepted');
  });

  it('a 5xx is a server error and a refused session an auth error; rows stay pending', async () => {
    await store.saveCapture(atGate(TRUCK_A));
    push = async () => {
      throw new ApiError(503, 'INTERNAL', 'Down');
    };
    expect(await engine().syncNow()).toEqual({
      ok: false,
      sent: 0,
      rejected: 0,
      pendingLeft: 1,
      error: 'server',
    });

    push = async () => {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Signed out');
    };
    expect(await engine().syncNow()).toMatchObject({ ok: false, error: 'auth', pendingLeft: 1 });
    expect((await store.outbox()).map((r) => [r.status, r.attempts])).toEqual([['pending', 2]]);
  });

  it('a failed pull after a good push reports the error but keeps the accepted rows', async () => {
    await store.saveCapture(atGate(TRUCK_A));
    const e = createSyncEngine({
      store,
      push: acceptAll(),
      pull: async () => {
        throw new NetworkError();
      },
      pullDoneToday: async () => DONE,
      now: () => NOW,
      random: () => 0.5,
    });

    expect(await e.syncNow()).toEqual({
      ok: false,
      sent: 1,
      rejected: 0,
      pendingLeft: 0,
      error: 'network',
    });
    expect((await store.outbox())[0]?.status).toBe('accepted');
  });

  it('pull without a cursor replaces the task list, with one applies changes and removals', async () => {
    pullPage = page([task(TRUCK_B)], [], '2026-11-13T06:10:00.000Z');
    await engine().syncNow();
    expect((await store.getTasks()).map((t) => t.truckId)).toEqual([TRUCK_B]);

    pullPage = page([task(TRUCK_A)], [TRUCK_B], '2026-11-13T06:20:00.000Z');
    await engine().syncNow();
    expect(pulls).toEqual([null, '2026-11-13T06:10:00.000Z']);
    expect((await store.getTasks()).map((t) => t.truckId)).toEqual([TRUCK_A]);
    expect((await store.meta()).cursor).toBe('2026-11-13T06:20:00.000Z');
  });

  it('estimates the clock offset from the server date header', async () => {
    await store.saveCapture(atGate(TRUCK_A));
    push = async (body) => ({
      ...(await acceptAll()(body)),
      serverDate: new Date(NOW + 600_000).toUTCString(),
    });

    await engine().syncNow();

    expect(Math.abs((await store.meta()).clockOffsetMs - 600_000)).toBeLessThan(1_000);
  });

  it('runs one sync at a time: a second call while one is running shares it', async () => {
    await store.saveCapture(atGate(TRUCK_A));
    const e = engine();
    const [a, b] = await Promise.all([e.syncNow(), e.syncNow()]);
    expect(a).toBe(b);
    expect(pushes).toHaveLength(1);
  });

  it('purges accepted rows older than 7 days', async () => {
    const old = createMemoryDeviceStore({ now: () => NOW - 8 * 86_400_000 });
    await old.replaceTasks(pullPage);
    const row = await old.saveCapture(atGate(TRUCK_A));
    await old.markResults([{ status: 'accepted', eventId: row.eventId, task: null }]);
    store = old;

    await engine().syncNow();

    expect(await store.outbox()).toEqual([]);
  });
});

describe('backoff', () => {
  it('starts at 2 s ± 20 % and never exceeds 5 min', () => {
    const e = engine();
    for (const r of [0, 0.5, 0.999]) {
      const d = backoff(0, r);
      expect(d).toBeGreaterThanOrEqual(1_600);
      expect(d).toBeLessThanOrEqual(2_400);
    }
    expect(backoff(0, 0.5)).toBe(2_000);
    expect(backoff(3, 0.5)).toBe(16_000);
    expect(e.nextDelayMs(0)).toBe(2_000);
    for (const f of [8, 9, 20, 1000]) {
      expect(backoff(f, 0.999)).toBeLessThanOrEqual(300_000);
      expect(e.nextDelayMs(f)).toBeLessThanOrEqual(300_000);
    }
  });
});

describe('sync loop', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('concurrent triggers (interval, kick, foreground) share one run and count its failure once', async () => {
    jest.useFakeTimers();
    let foreground: ((s: AppStateStatus) => void) | undefined;
    const original = AppState.addEventListener;
    AppState.addEventListener = ((_type: string, handler: (s: AppStateStatus) => void) => {
      foreground = handler;
      return { remove: () => undefined };
    }) as unknown as typeof AppState.addEventListener;
    await store.saveCapture(atGate(TRUCK_A));
    let release: () => void = () => undefined;
    push = () =>
      new Promise((_, reject) => {
        release = () => reject(new NetworkError());
      });
    const real = engine();
    const delays: number[] = [];
    const counted: SyncEngine = {
      syncNow: () => real.syncNow(),
      nextDelayMs: (f) => {
        delays.push(f);
        return real.nextDelayMs(f);
      },
    };

    const loop = startSyncLoop(counted, store);
    await jest.advanceTimersByTimeAsync(60_000); // interval tick while the first run is out
    loop.kick();
    foreground?.('active');
    await jest.advanceTimersByTimeAsync(0);
    release();
    await jest.advanceTimersByTimeAsync(0);

    expect(pushes).toHaveLength(1);
    expect(delays).toEqual([0]); // one failure, one retry timer
    expect(useSyncStatus.getState()).toMatchObject({ online: false, syncing: false, pending: 1 });

    loop.stop();
    AppState.addEventListener = original;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a store error during a run is caught and syncing goes back to false', async () => {
    jest.useFakeTimers();
    const broken: DeviceStore = {
      ...store,
      outbox: async () => {
        throw new Error('disk full');
      },
    };
    const fake: SyncEngine = {
      syncNow: async () => ({ ok: true, sent: 0, rejected: 0, pendingLeft: 0 }),
      nextDelayMs: () => 2_000,
    };

    const loop = startSyncLoop(fake, broken);
    await jest.advanceTimersByTimeAsync(0);

    expect(useSyncStatus.getState().syncing).toBe(false);
    loop.stop();
  });

  it('a kick during a run (e.g. its pull) schedules exactly one follow-up run, not a 60 s wait', async () => {
    jest.useFakeTimers();
    const OK: SyncOutcome = { ok: true, sent: 0, rejected: 0, pendingLeft: 0 };
    let runs = 0;
    let release: () => void = () => undefined;
    const fake: SyncEngine = {
      syncNow: () => {
        runs += 1;
        if (runs > 1) return Promise.resolve(OK);
        return new Promise((resolve) => {
          release = () => resolve(OK);
        });
      },
      nextDelayMs: () => 2_000,
    };

    const loop = startSyncLoop(fake, store);
    await jest.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    const followUp = loop.kick(); // a capture saved while the first run is out
    void loop.kick(); // and another: still one follow-up
    await jest.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    release();
    await followUp;
    expect(runs).toBe(2);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(2);

    loop.stop();
  });

  it('a kick during a run that fails leaves the retry to backoff (no immediate rerun)', async () => {
    jest.useFakeTimers();
    let runs = 0;
    let release: () => void = () => undefined;
    const fake: SyncEngine = {
      syncNow: () => {
        runs += 1;
        return new Promise((resolve) => {
          release = () => resolve({ ok: false, sent: 0, rejected: 0, pendingLeft: 1, error: 'network' });
        });
      },
      nextDelayMs: () => 2_000,
    };

    const loop = startSyncLoop(fake, store);
    await jest.advanceTimersByTimeAsync(0);
    const followUp = loop.kick();
    release();
    await followUp;
    expect(runs).toBe(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(runs).toBe(2);
    loop.stop();
  });

  it('runs at once, retries a failure with backoff, then every 60 s; stop ends it', async () => {
    jest.useFakeTimers();
    const outcomes: SyncOutcome[] = [
      { ok: false, sent: 0, rejected: 0, pendingLeft: 1, error: 'network' },
      { ok: true, sent: 1, rejected: 0, pendingLeft: 0 },
    ];
    let runs = 0;
    const fake: SyncEngine = {
      syncNow: async () => outcomes[Math.min(runs++, outcomes.length - 1)] as SyncOutcome,
      nextDelayMs: (f) => backoff(f, 0.5),
    };

    const loop = startSyncLoop(fake, store);
    await jest.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    expect(useSyncStatus.getState()).toMatchObject({ online: false, syncing: false });

    await jest.advanceTimersByTimeAsync(2_000);
    expect(runs).toBe(2);
    expect(useSyncStatus.getState().online).toBe(true);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(3);

    loop.kick();
    await jest.advanceTimersByTimeAsync(0);
    expect(runs).toBe(4);

    loop.stop();
    await jest.advanceTimersByTimeAsync(300_000);
    expect(runs).toBe(4);
  });
});
