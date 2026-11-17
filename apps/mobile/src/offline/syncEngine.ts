import {
  type DoneToday,
  type SyncBody,
  type SyncResult,
  type TasksPage,
  NetworkError,
} from '@tonnage/shared';
import { ApiError } from '../api/client';
import { backoff } from './backoff';
import { type DeviceStore, type MetaPatch, type OutboxRow, toSyncEvent } from './deviceStore';

/** At most this many events per `POST /v1/weighments/sync` (the shared body allows 100). */
export const SYNC_BATCH = 100;
/** Accepted outbox rows are kept this long, then purged (§6.8). */
export const KEEP_ACCEPTED_MS = 7 * 24 * 60 * 60_000;

export type SyncError = 'network' | 'auth' | 'server';

export interface SyncOutcome {
  ok: boolean;
  /** Events sent and answered in this run. */
  sent: number;
  /** Of those, rejected by the server. */
  rejected: number;
  /** Rows still waiting to be sent (`pending` or `sending`). */
  pendingLeft: number;
  error?: SyncError;
}

export interface SyncEngineDeps {
  store: DeviceStore;
  /** `POST /v1/weighments/sync`; `serverDate` is the response's `Date` header, when there is one. */
  push(body: SyncBody): Promise<{ results: SyncResult[]; serverDate: string | null }>;
  /** `GET /v1/supervisor/tasks?cursor=`. */
  pull(cursor: string | null): Promise<TasksPage>;
  pullDoneToday(): Promise<DoneToday>;
  now(): number;
  random(): number;
}

export interface SyncEngine {
  /**
   * Pushes pending events (and, once per run, rows held behind a refusal), then pulls tasks and
   * done today. Concurrent calls share one run.
   */
  syncNow(): Promise<SyncOutcome>;
  /** Delay before retrying after `failures` failed runs in a row. */
  nextDelayMs(failures: number): number;
}

/** No HTTP answer → network; a refused session → auth; anything else → server. */
function classify(e: unknown): SyncError {
  if (e instanceof NetworkError) return 'network';
  if (e instanceof ApiError && e.status === 401) return 'auth';
  return 'server';
}

/** Server minus device clock from an HTTP `Date` (1 s resolution) or an ISO time. */
function offsetFrom(serverTime: string | null, now: number): number | null {
  if (!serverTime) return null;
  const t = Date.parse(serverTime);
  return Number.isFinite(t) ? t - now : null;
}

/**
 * Rows held behind a refusal, to send again so they reach the server (and Needs attention): for
 * each truck with `blocked` rows, its latest `rejected` row before them (the server answers that
 * replay with the same refusal and blocks the truck's later events in the request), then the
 * blocked rows in `deviceSeq` order. A truck with only `rejected` rows sends nothing: those were
 * answered already. With no refused row left (resolved), the blocked rows simply go.
 */
async function heldRows(store: DeviceStore): Promise<OutboxRow[]> {
  const rows = await store.outbox({ status: ['rejected', 'blocked'] });
  const trucks = [...new Set(rows.filter((r) => r.status === 'blocked').map((r) => r.truckId))];
  return trucks.flatMap((truckId) => {
    const blocked = rows.filter((r) => r.truckId === truckId && r.status === 'blocked');
    const first = blocked[0]?.deviceSeq ?? 0;
    const lead = rows.filter((r) => r.truckId === truckId && r.status === 'rejected' && r.deviceSeq < first).pop();
    return lead ? [lead, ...blocked] : blocked;
  });
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { store } = deps;
  let running: Promise<SyncOutcome> | null = null;

  const pendingLeft = async () => (await store.outbox({ status: ['pending', 'sending'] })).length;

  async function run(): Promise<SyncOutcome> {
    let sent = 0;
    let rejected = 0;
    let pushed = false;
    const { deviceId } = await store.meta();

    try {
      // Only one run is ever out, so a `sending` row now was left by a run that never finished
      // (the app was killed mid-request): send it again; the server de-duplicates by event id.
      const stale = await store.outbox({ status: ['sending'] });
      if (stale.length > 0) await store.requeue(stale.map((r) => r.eventId));
      // Held rows go once per run, in the first request, ahead of the pending ones.
      let held = await heldRows(store);
      // Rows saved while a request is out, or behind the first 100, go in the next round.
      for (;;) {
        const batch = [...held, ...(await store.outbox({ status: ['pending'] }))].slice(0, SYNC_BATCH);
        held = [];
        if (batch.length === 0) break;
        // Only pending rows go to `sending` (and back on a failure); held rows keep their status.
        const ids = batch.filter((r) => r.status === 'pending').map((r) => r.eventId);
        await store.markSending(ids);
        let answer: Awaited<ReturnType<SyncEngineDeps['push']>>;
        try {
          answer = await deps.push({ deviceId, events: batch.map(toSyncEvent) });
        } catch (e) {
          await store.requeue(ids);
          throw e;
        }
        await store.markResults(answer.results);
        // A pending event the server did not answer (never expected) is simply sent again.
        const answered = new Set(answer.results.map((r) => r.eventId));
        const missing = ids.filter((id) => !answered.has(id));
        if (missing.length > 0) await store.requeue(missing);
        sent += answer.results.length;
        rejected += answer.results.filter((r) => r.status === 'rejected').length;
        const offset = offsetFrom(answer.serverDate, deps.now());
        if (offset !== null) await store.setMeta({ clockOffsetMs: offset });
        pushed = true;
        if (missing.length > 0) break; // do not spin on an event the server keeps ignoring
      }

      const page = await deps.pull((await store.meta()).cursor);
      await store.replaceTasks(page);
      await store.setDoneToday(await deps.pullDoneToday());
      const at = deps.now();
      const meta: MetaPatch = {
        lastSyncAt: new Date(at).toISOString(),
      };
      if (!pushed) {
        const offset = offsetFrom(page.serverTime, at);
        if (offset !== null) meta.clockOffsetMs = offset;
      }
      await store.setMeta(meta);
      await store.purgeAccepted(KEEP_ACCEPTED_MS, at);
      return { ok: true, sent, rejected, pendingLeft: await pendingLeft() };
    } catch (e) {
      return { ok: false, sent, rejected, pendingLeft: await pendingLeft(), error: classify(e) };
    }
  }

  return {
    syncNow() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    nextDelayMs: (failures) => backoff(failures, deps.random()),
  };
}
