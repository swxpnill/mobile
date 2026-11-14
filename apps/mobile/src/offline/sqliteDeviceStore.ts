import * as Crypto from 'expo-crypto';
import type { DoneToday, SyncResult, Task } from '@tonnage/shared';
import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  type DeviceStore,
  type DeviceStoreOptions,
  type OutboxRow,
  type OutboxStatus,
  type SyncMeta,
  createMemoryDeviceStore,
  defaultMeta,
  toSyncEvent,
} from './deviceStore';

/** Spec §6.2. JSON columns hold server shapes; no prices are ever stored on the device. */
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS tasks (
  truck_id TEXT PRIMARY KEY NOT NULL,
  ord INTEGER NOT NULL,
  server_version INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS done_today (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY NOT NULL,
  truck_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  captured_at_device TEXT NOT NULL,
  device_seq INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_truck ON outbox (truck_id, device_seq);
CREATE TABLE IF NOT EXISTS sync_meta (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  cursor TEXT,
  clock_offset_ms INTEGER NOT NULL,
  last_sync_at TEXT,
  next_device_seq INTEGER NOT NULL,
  device_id TEXT NOT NULL
);
`;

interface OutboxSql {
  event_id: string;
  truck_id: string;
  type: OutboxRow['type'];
  payload: string;
  captured_at_device: string;
  device_seq: number;
  status: OutboxStatus;
  attempts: number;
  error: string | null;
  accepted_at: string | null;
}

interface MetaSql {
  cursor: string | null;
  clock_offset_ms: number;
  last_sync_at: string | null;
  next_device_seq: number;
  device_id: string;
}

const toRow = (r: OutboxSql): OutboxRow => ({
  eventId: r.event_id,
  truckId: r.truck_id,
  type: r.type,
  payload: JSON.parse(r.payload) as OutboxRow['payload'],
  capturedAtDevice: r.captured_at_device,
  deviceSeq: r.device_seq,
  status: r.status,
  attempts: r.attempts,
  error: r.error === null ? null : (JSON.parse(r.error) as OutboxRow['error']),
  acceptedAt: r.accepted_at,
});

const toMeta = (m: MetaSql): SyncMeta => ({
  cursor: m.cursor,
  clockOffsetMs: m.clock_offset_ms,
  lastSyncAt: m.last_sync_at,
  nextDeviceSeq: m.next_device_seq,
  deviceId: m.device_id,
});

const marks = (n: number) => Array(n).fill('?').join(', ');

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

async function upsertTask(db: Db, t: Task, onlyNewer: boolean): Promise<void> {
  await db.runAsync(
    `INSERT INTO tasks (truck_id, ord, server_version, json)
     VALUES (?, (SELECT COALESCE(MAX(ord), -1) + 1 FROM tasks), ?, ?)
     ON CONFLICT (truck_id) DO UPDATE SET server_version = excluded.server_version, json = excluded.json
     ${onlyNewer ? 'WHERE excluded.server_version >= tasks.server_version' : ''}`,
    t.truckId,
    t.version,
    JSON.stringify(t),
  );
}

/**
 * `DeviceStore` on expo-sqlite: a thin mapping of the memory store's behaviour, proven by
 * `deviceStoreContract` on the phone. Multi-statement writes run in exclusive transactions.
 */
export async function createSqliteDeviceStore(
  db: SQLiteDatabase,
  opts: DeviceStoreOptions = {},
): Promise<DeviceStore> {
  const now = opts.now ?? Date.now;
  await db.execAsync(SCHEMA);
  const m = defaultMeta((opts.newId ?? Crypto.randomUUID)());
  await db.runAsync(
    `INSERT OR IGNORE INTO sync_meta (id, cursor, clock_offset_ms, last_sync_at, next_device_seq, device_id)
     VALUES (1, NULL, 0, NULL, 0, ?)`,
    m.deviceId,
  );

  const readMeta = async (q: Db) =>
    toMeta((await q.getFirstAsync<MetaSql>('SELECT * FROM sync_meta WHERE id = 1')) as MetaSql);

  return {
    async getTasks() {
      const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM tasks ORDER BY ord');
      return rows.map((r) => JSON.parse(r.json) as Task);
    },

    async replaceTasks(page) {
      await db.withExclusiveTransactionAsync(async (tx) => {
        const { cursor } = await readMeta(tx);
        if (cursor === null) await tx.runAsync('DELETE FROM tasks');
        else if (page.removed.length > 0)
          await tx.runAsync(
            `DELETE FROM tasks WHERE truck_id IN (${marks(page.removed.length)})`,
            ...page.removed,
          );
        for (const t of page.items) await upsertTask(tx, t, false);
        await tx.runAsync('UPDATE sync_meta SET cursor = ? WHERE id = 1', page.cursor);
      });
    },

    async getDoneToday() {
      const row = await db.getFirstAsync<{ json: string }>(
        'SELECT json FROM done_today WHERE id = 1',
      );
      return row ? (JSON.parse(row.json) as DoneToday) : null;
    },

    async setDoneToday(d) {
      await db.runAsync(
        'INSERT OR REPLACE INTO done_today (id, json) VALUES (1, ?)',
        JSON.stringify(d),
      );
    },

    async saveCapture(input) {
      let saved: OutboxRow | undefined;
      await db.withExclusiveTransactionAsync(async (tx) => {
        const deviceSeq = (await readMeta(tx)).nextDeviceSeq;
        await tx.runAsync(
          'UPDATE sync_meta SET next_device_seq = next_device_seq + 1 WHERE id = 1',
        );
        toSyncEvent({ ...input, deviceSeq });
        const task = await tx.getFirstAsync(
          'SELECT 1 FROM tasks WHERE truck_id = ?',
          input.truckId,
        );
        if (!task) throw new Error('This truck is not on this phone');
        const held = await tx.getFirstAsync(
          `SELECT 1 FROM outbox WHERE truck_id = ? AND status IN ('rejected', 'blocked')`,
          input.truckId,
        );
        const row: OutboxRow = {
          ...input,
          deviceSeq,
          status: held ? 'blocked' : 'pending',
          attempts: 0,
          error: null,
          acceptedAt: null,
        };
        // A taken event id fails here (primary key) and the whole save rolls back.
        await tx.runAsync(
          `INSERT INTO outbox (event_id, truck_id, type, payload, captured_at_device, device_seq, status, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          row.eventId,
          row.truckId,
          row.type,
          JSON.stringify(row.payload),
          row.capturedAtDevice,
          row.deviceSeq,
          row.status,
        );
        saved = row;
      });
      return saved as OutboxRow;
    },

    async outbox(filter) {
      const statuses = filter?.status;
      const rows = statuses
        ? await db.getAllAsync<OutboxSql>(
            `SELECT * FROM outbox WHERE status IN (${marks(statuses.length)}) ORDER BY device_seq`,
            ...statuses,
          )
        : await db.getAllAsync<OutboxSql>('SELECT * FROM outbox ORDER BY device_seq');
      return rows.map(toRow);
    },

    async markSending(eventIds) {
      if (eventIds.length === 0) return;
      await db.runAsync(
        `UPDATE outbox SET status = 'sending' WHERE status = 'pending' AND event_id IN (${marks(eventIds.length)})`,
        ...eventIds,
      );
    },

    async markResults(results: SyncResult[]) {
      const acceptedAt = new Date(now()).toISOString();
      await db.withExclusiveTransactionAsync(async (tx) => {
        for (const res of results) {
          const row = await tx.getFirstAsync<OutboxSql>(
            'SELECT * FROM outbox WHERE event_id = ?',
            res.eventId,
          );
          if (!row) continue;
          if (res.status === 'rejected') {
            await tx.runAsync(
              `UPDATE outbox SET status = 'rejected', error = ? WHERE event_id = ?`,
              JSON.stringify({ code: res.code, message: res.message }),
              res.eventId,
            );
            await tx.runAsync(
              `UPDATE outbox SET status = 'blocked' WHERE truck_id = ? AND device_seq > ? AND status = 'pending'`,
              row.truck_id,
              row.device_seq,
            );
            continue;
          }
          await tx.runAsync(
            `UPDATE outbox SET status = 'accepted', error = NULL, accepted_at = ? WHERE event_id = ?`,
            acceptedAt,
            res.eventId,
          );
          if (res.status === 'accepted') {
            if (res.task === null)
              await tx.runAsync('DELETE FROM tasks WHERE truck_id = ?', row.truck_id);
            else await upsertTask(tx, res.task, true);
          }
        }
      });
    },

    async requeue(eventIds) {
      if (eventIds.length === 0) return;
      await db.runAsync(
        `UPDATE outbox SET status = 'pending', attempts = attempts + 1, error = NULL
         WHERE status <> 'accepted' AND event_id IN (${marks(eventIds.length)})`,
        ...eventIds,
      );
    },

    async purgeAccepted(olderThanMs, at) {
      // ISO strings from toISOString() compare in time order.
      const res = await db.runAsync(
        `DELETE FROM outbox WHERE status = 'accepted' AND accepted_at < ?`,
        new Date(at - olderThanMs).toISOString(),
      );
      return res.changes;
    },

    meta: () => readMeta(db),

    async setMeta(patch) {
      const next = { ...(await readMeta(db)), ...patch };
      await db.runAsync(
        `UPDATE sync_meta SET cursor = ?, clock_offset_ms = ?, last_sync_at = ?, next_device_seq = ?, device_id = ?
         WHERE id = 1`,
        next.cursor,
        next.clockOffsetMs,
        next.lastSyncAt,
        next.nextDeviceSeq,
        next.deviceId,
      );
    },

    async clear() {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.execAsync('DELETE FROM tasks; DELETE FROM done_today; DELETE FROM outbox;');
        await tx.runAsync(
          'UPDATE sync_meta SET cursor = NULL, clock_offset_ms = 0, last_sync_at = NULL WHERE id = 1',
        );
      });
    },
  };
}

/** Database file of one signed-in user's device store (plan Ruling 6). */
export const deviceDbName = (userId: string) => `tonnage-device-${userId}.db`;

const opened = new Map<string, Promise<DeviceStore>>();

/**
 * The device store of `userId`, opened once per run: SQLite on Android/iOS, memory on web and
 * under jest (expo-sqlite's native module does not exist there).
 */
export function openDeviceStore(userId: string): Promise<DeviceStore> {
  let store = opened.get(userId);
  if (!store) {
    store =
      Platform.OS === 'web' || process.env.NODE_ENV === 'test'
        ? Promise.resolve(createMemoryDeviceStore())
        : import('expo-sqlite').then(async (sqlite) =>
            createSqliteDeviceStore(await sqlite.openDatabaseAsync(deviceDbName(userId))),
          );
    store.catch(() => opened.delete(userId));
    opened.set(userId, store);
  }
  return store;
}
