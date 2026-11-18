import * as Crypto from 'expo-crypto';
import {
  type DoneToday,
  type SyncEvent,
  type SyncResult,
  type Task,
  type TasksPage,
  syncEventSchema,
} from '@tonnage/shared';

/**
 * `resolved` is terminal: the owner restored or dismissed the refused event on the server (a pull's
 * `resolved`), so the row neither counts as unsent nor holds its truck.
 */
export type OutboxStatus = 'pending' | 'sending' | 'accepted' | 'rejected' | 'blocked' | 'resolved';

/** One weighment event captured on this phone (§6.2 `outbox`). Weights are integer kg. */
export interface OutboxRow {
  eventId: string;
  truckId: string;
  type: 'AT_GATE' | 'TARE' | 'GROSS';
  payload: {
    tareKg?: number;
    grossKg?: number;
    allocations?: { orderLineId: string; netKg: number }[];
  };
  capturedAtDevice: string;
  /** Monotonic per device store, from `SyncMeta.nextDeviceSeq`. */
  deviceSeq: number;
  status: OutboxStatus;
  attempts: number;
  error: { code: string; message: string } | null;
  acceptedAt: string | null;
}

export type NewCapture = Omit<
  OutboxRow,
  'deviceSeq' | 'status' | 'attempts' | 'error' | 'acceptedAt'
>;

export interface SyncMeta {
  /** Server `changedAt` of the newest change pulled; null before the first pull (full snapshot). */
  cursor: string | null;
  /** Server clock minus device clock, from the last response's `Date`. */
  clockOffsetMs: number;
  lastSyncAt: string | null;
  nextDeviceSeq: number;
  /** Random, made once per store; never a native device id. */
  deviceId: string;
}

/** The meta fields the sync engine may write. */
export type MetaPatch = Partial<Pick<SyncMeta, 'cursor' | 'clockOffsetMs' | 'lastSyncAt'>>;

/**
 * Everything the supervisor's phone keeps for offline weighment (spec §6.2), one store per
 * signed-in user. Implementations: `createMemoryDeviceStore` (tests, web) and
 * `createSqliteDeviceStore` (the app); both pass `deviceStoreContract`.
 */
export interface DeviceStore {
  /** Server tasks as last pulled (or as updated by accepted sync results), in server order. */
  getTasks(): Promise<Task[]>;
  /**
   * Applies a pull and stores its cursor, in one transaction. With no stored cursor the page is
   * a full snapshot and replaces every task; with one, `items` are upserted and `removed` deleted
   * (idempotent: a change at the cursor may come back again). `resolved` event ids move their
   * `rejected`/`blocked` rows to `resolved`.
   */
  replaceTasks(page: TasksPage): Promise<void>;
  getDoneToday(): Promise<DoneToday | null>;
  setDoneToday(d: DoneToday): Promise<void>;
  /**
   * Saves a captured event in one transaction: takes `deviceSeq = nextDeviceSeq++` and stores the
   * row `pending` (`blocked` when the truck already has a rejected or blocked event). Throws, and
   * stores nothing, when the event is malformed, the truck is not on this phone or the id is taken.
   * `task` (the owner weighing from Dispatch, Ruling 4) is upserted first in the same transaction,
   * unless the phone already holds a newer version of it.
   */
  saveCapture(row: NewCapture, opts?: { task?: Task }): Promise<OutboxRow>;
  /** Rows oldest `deviceSeq` first, optionally only those with one of `status`. */
  outbox(filter?: { status?: OutboxStatus[] }): Promise<OutboxRow[]>;
  /** `pending` → `sending` for a request about to go out. */
  markSending(eventIds: string[]): Promise<void>;
  /**
   * Applies sync results in one transaction: `accepted`/`duplicate` → accepted (an accepted
   * result's task replaces the stored one; a null task — dispatched — removes it); `rejected` →
   * rejected with its error, and every later `pending` row of that truck → `blocked`.
   */
  markResults(results: SyncResult[]): Promise<void>;
  /** Back to `pending` with one more attempt (a request that failed); accepted rows are left alone. */
  requeue(eventIds: string[]): Promise<void>;
  /** Deletes accepted rows accepted before `now - olderThanMs`; returns how many. */
  purgeAccepted(olderThanMs: number, now: number): Promise<number>;
  meta(): Promise<SyncMeta>;
  /**
   * Changes only the given fields. `nextDeviceSeq` (moved by `saveCapture` alone) and `deviceId`
   * (made once) are not writable: a meta write racing a save must never move the counter back.
   */
  setMeta(m: MetaPatch): Promise<void>;
  /** Empties tasks, outbox and done today; keeps `deviceId` and `nextDeviceSeq`. */
  clear(): Promise<void>;
}

export interface DeviceStoreOptions {
  /** Clock for `acceptedAt`. */
  now?: () => number;
  /** Makes the device id. */
  newId?: () => string;
}

/** The wire event for a row; throws when the row is malformed (missing or non-integer kg, …). */
export function toSyncEvent(
  row: Omit<OutboxRow, 'status' | 'attempts' | 'error' | 'acceptedAt'>,
): SyncEvent {
  const base = {
    eventId: row.eventId,
    truckId: row.truckId,
    deviceSeq: row.deviceSeq,
    capturedAtDevice: row.capturedAtDevice,
  };
  const { tareKg, grossKg, allocations } = row.payload;
  switch (row.type) {
    case 'AT_GATE':
      return syncEventSchema.parse({ ...base, type: 'AT_GATE' });
    case 'TARE':
      return syncEventSchema.parse({ ...base, type: 'TARE', tareKg });
    case 'GROSS':
      return syncEventSchema.parse({ ...base, type: 'GROSS', grossKg, allocations });
  }
}

/** Events in flight or waiting count as local; accepted ones are in the server task already. */
const LOCAL: OutboxStatus[] = ['pending', 'sending'];

/**
 * The task list as the phone shows it: server tasks with this phone's unsent events applied on
 * top (§6.3). At gate → `at_gate`; tare → `loading` with that tare and its time; gross → gone
 * from the list.
 */
export function displayTasks(
  tasks: Task[],
  outbox: OutboxRow[],
): (Task & { localPending: boolean })[] {
  const local = outbox
    .filter((r) => LOCAL.includes(r.status))
    .sort((a, b) => a.deviceSeq - b.deviceSeq);
  const shown: (Task & { localPending: boolean })[] = [];
  for (const t of tasks) {
    let view: Task & { localPending: boolean } = { ...t, localPending: false };
    let gone = false;
    for (const r of local) {
      if (r.truckId !== t.truckId) continue;
      if (r.type === 'AT_GATE') view = { ...view, state: 'at_gate', localPending: true };
      else if (r.type === 'TARE')
        view = {
          ...view,
          state: 'loading',
          tareKg: r.payload.tareKg ?? null,
          tareAt: r.capturedAtDevice,
          localPending: true,
        };
      else gone = true;
    }
    if (!gone) shown.push(view);
  }
  return shown;
}

export function defaultMeta(deviceId: string): SyncMeta {
  return { cursor: null, clockOffsetMs: 0, lastSyncAt: null, nextDeviceSeq: 0, deviceId };
}

interface MemoryState {
  tasks: Task[];
  outbox: OutboxRow[];
  doneToday: DoneToday | null;
  meta: SyncMeta;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** In-memory `DeviceStore` (tests, web). Writes are all-or-nothing like the SQLite transactions. */
export function createMemoryDeviceStore(opts: DeviceStoreOptions = {}): DeviceStore {
  const now = opts.now ?? Date.now;
  let s: MemoryState = {
    tasks: [],
    outbox: [],
    doneToday: null,
    meta: defaultMeta((opts.newId ?? Crypto.randomUUID)()),
  };

  /** Runs `fn` against the state; on a throw the state is as it was before. */
  function tx<T>(fn: (st: MemoryState) => T): T {
    const before = copy(s);
    try {
      return fn(s);
    } catch (e) {
      s = before;
      throw e;
    }
  }

  const upsert = (st: MemoryState, t: Task) => {
    const i = st.tasks.findIndex((x) => x.truckId === t.truckId);
    if (i === -1) st.tasks.push(copy(t));
    else if (t.version >= (st.tasks[i]?.version ?? 0)) st.tasks[i] = copy(t);
  };

  return {
    async getTasks() {
      return copy(s.tasks);
    },

    async replaceTasks(page) {
      tx((st) => {
        if (st.meta.cursor === null) {
          st.tasks = copy(page.items);
        } else {
          const gone = new Set(page.removed);
          st.tasks = st.tasks.filter((t) => !gone.has(t.truckId));
          for (const t of page.items) {
            const i = st.tasks.findIndex((x) => x.truckId === t.truckId);
            if (i === -1) st.tasks.push(copy(t));
            else st.tasks[i] = copy(t);
          }
        }
        const resolved = new Set(page.resolved);
        for (const r of st.outbox)
          if (resolved.has(r.eventId) && (r.status === 'rejected' || r.status === 'blocked'))
            r.status = 'resolved';
        st.meta.cursor = page.cursor;
      });
    },

    async getDoneToday() {
      return copy(s.doneToday);
    },

    async setDoneToday(d) {
      s.doneToday = copy(d);
    },

    async saveCapture(input, opts) {
      return tx((st) => {
        const deviceSeq = st.meta.nextDeviceSeq;
        st.meta.nextDeviceSeq += 1;
        toSyncEvent({ ...input, deviceSeq });
        if (opts?.task) upsert(st, opts.task);
        if (st.outbox.some((r) => r.eventId === input.eventId))
          throw new Error('Event already saved');
        if (!st.tasks.some((t) => t.truckId === input.truckId))
          throw new Error('This truck is not on this phone');
        const held = st.outbox.some(
          (r) => r.truckId === input.truckId && (r.status === 'rejected' || r.status === 'blocked'),
        );
        const row: OutboxRow = {
          ...copy(input),
          deviceSeq,
          status: held ? 'blocked' : 'pending',
          attempts: 0,
          error: null,
          acceptedAt: null,
        };
        st.outbox.push(row);
        return copy(row);
      });
    },

    async outbox(filter) {
      const rows = filter?.status
        ? s.outbox.filter((r) => filter.status?.includes(r.status))
        : s.outbox;
      return copy([...rows].sort((a, b) => a.deviceSeq - b.deviceSeq));
    },

    async markSending(eventIds) {
      for (const r of s.outbox)
        if (eventIds.includes(r.eventId) && r.status === 'pending') r.status = 'sending';
    },

    async markResults(results) {
      tx((st) => {
        for (const res of results) {
          const row = st.outbox.find((r) => r.eventId === res.eventId);
          if (!row) continue;
          if (res.status === 'rejected') {
            row.status = 'rejected';
            row.error = { code: res.code, message: res.message };
            for (const r of st.outbox) {
              if (
                r.truckId === row.truckId &&
                r.deviceSeq > row.deviceSeq &&
                r.status === 'pending'
              )
                r.status = 'blocked';
            }
            continue;
          }
          row.status = 'accepted';
          row.error = null;
          row.acceptedAt = new Date(now()).toISOString();
          if (res.status === 'accepted') {
            if (res.task === null) st.tasks = st.tasks.filter((t) => t.truckId !== row.truckId);
            else upsert(st, res.task);
          }
        }
      });
    },

    async requeue(eventIds) {
      for (const r of s.outbox) {
        if (!eventIds.includes(r.eventId) || r.status === 'accepted') continue;
        r.status = 'pending';
        r.attempts += 1;
        r.error = null;
      }
    },

    async purgeAccepted(olderThanMs, at) {
      const cutoff = at - olderThanMs;
      const before = s.outbox.length;
      s.outbox = s.outbox.filter(
        (r) =>
          !(r.status === 'accepted' && r.acceptedAt !== null && Date.parse(r.acceptedAt) < cutoff),
      );
      return before - s.outbox.length;
    },

    async meta() {
      return copy(s.meta);
    },

    async setMeta(m) {
      if (m.cursor !== undefined) s.meta.cursor = m.cursor;
      if (m.clockOffsetMs !== undefined) s.meta.clockOffsetMs = m.clockOffsetMs;
      if (m.lastSyncAt !== undefined) s.meta.lastSyncAt = m.lastSyncAt;
    },

    async clear() {
      const { deviceId, nextDeviceSeq } = s.meta;
      s = {
        tasks: [],
        outbox: [],
        doneToday: null,
        meta: { ...defaultMeta(deviceId), nextDeviceSeq },
      };
    },
  };
}
