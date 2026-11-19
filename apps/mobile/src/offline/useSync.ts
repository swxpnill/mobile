import {
  type Role,
  type SyncBody,
  type Task,
  NetworkError,
  doneTodaySchema,
  syncResponseSchema,
  tasksPageSchema,
} from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { api, apiWithDate } from '../api/client';
import { useMe } from '../api/hooks/me';
import { refreshRejections } from '../api/hooks/rejections';
import { useSession } from '../auth/session';
import type { DeviceStore, NewCapture, OutboxRow } from './deviceStore';
import { openDeviceStore } from './sqliteDeviceStore';
import { type SyncEngine, type SyncOutcome, createSyncEngine } from './syncEngine';
import { withSyncLock } from './syncLock';

/** Sync every minute while the app is open (plan Ruling 5). */
export const SYNC_INTERVAL_MS = 60_000;
/** Roles that weigh trucks on this phone (plan Ruling 4). */
export const CAPTURE_ROLES: readonly Role[] = ['supervisor', 'owner'];

export interface SyncStatus {
  /** Result of the last request: true on any HTTP answer, false on a network error, null before one. */
  online: boolean | null;
  /** Events not yet sent (`pending` or `sending`). */
  pending: number;
  /** Events the server refused, or held behind a refusal (`rejected` or `blocked`). */
  rejected: number;
  lastSyncAt: string | null;
  syncing: boolean;
}

const IDLE: SyncStatus = {
  online: null,
  pending: 0,
  rejected: 0,
  lastSyncAt: null,
  syncing: false,
};

export const useSyncStatus = create<SyncStatus>(() => IDLE);

/**
 * Weights on this phone that have not reached the server for good: waiting or in flight, and
 * those refused or held behind a refusal (until the owner resolves them). The sign-out guard counts these.
 */
export const notSent = (s: Pick<SyncStatus, 'pending' | 'rejected'>): number => s.pending + s.rejected;

/** The signed-in user's device store while the sync loop runs; null otherwise. */
export const useDeviceStore = create<{ store: DeviceStore | null }>(() => ({ store: null }));

/**
 * Bumped whenever the device store may have changed (a sync run ended, a capture was saved), so
 * screens reading the store read it again.
 */
export const useDeviceRevision = create<{ rev: number }>(() => ({ rev: 0 }));
const bumpRevision = () => useDeviceRevision.setState((s) => ({ rev: s.rev + 1 }));

let running: SyncLoop | null = null;

/** True while the signed-in capture role's loop runs (the app is open). */
export const isLoopRunning = (): boolean => running !== null;

/** Sync now (after a local save). Does nothing when no loop runs. */
export function requestSync(): void {
  void running?.kick();
}

/** Sync now and wait for that run (pull to refresh, "Send now"); resolves at once with no loop. */
export function syncNow(): Promise<void> {
  return running?.kick() ?? Promise.resolve();
}

/**
 * Saves a captured weight on this phone (one device-store transaction), then publishes the new
 * counts and syncs. Resolves only after the save committed: the caller may then say "Saved on
 * this phone".
 */
export async function recordCapture(
  store: DeviceStore,
  input: NewCapture,
  opts?: { task?: Task },
): Promise<OutboxRow> {
  const row = await store.saveCapture(input, opts);
  bumpRevision();
  try {
    useSyncStatus.setState(await publishCounts(store));
  } catch {
    // The counts catch up on the next sync run.
  }
  requestSync();
  return row;
}

export interface SyncLoop {
  /**
   * Runs now; during a run, schedules exactly one follow-up run after it (a capture saved while
   * a run is pulling must not wait for the next interval). Resolves when that run has finished.
   */
  kick(): Promise<void>;
  stop(): void;
}

async function publishCounts(
  store: DeviceStore,
): Promise<Pick<SyncStatus, 'pending' | 'rejected' | 'lastSyncAt'>> {
  const rows = await store.outbox();
  return {
    pending: rows.filter((r) => r.status === 'pending' || r.status === 'sending').length,
    rejected: rows.filter((r) => r.status === 'rejected' || r.status === 'blocked').length,
    lastSyncAt: (await store.meta()).lastSyncAt,
  };
}

/**
 * Runs `engine` now, every 60 s, when the app comes to the foreground and on `kick()`; after a
 * failed run it retries with backoff until a run succeeds (an auth failure waits for the next
 * trigger instead). Publishes `useSyncStatus`.
 */
export function startSyncLoop(engine: SyncEngine, store: DeviceStore, onSynced?: () => void): SyncLoop {
  let stopped = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  let inFlight: Promise<void> | null = null;
  /** A kick arrived during the run in flight: run once more after it. */
  let dirty = false;
  let followUp: Promise<void> | null = null;
  let lastOk = false;

  /** Triggers that arrive while a run is out share it; only that run handles its outcome. */
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /**
   * A kick during a run may carry an event that run already passed (it is pulling): one
   * follow-up run sends it. After a failed run the backoff retry is that follow-up.
   */
  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (!inFlight) return tick();
    dirty = true;
    followUp ??= inFlight.then(() => {
      followUp = null;
      const again = dirty && lastOk;
      dirty = false;
      return again ? tick() : undefined;
    });
    return followUp;
  }

  async function run(): Promise<void> {
    clearTimeout(retry);
    retry = undefined;
    let out: SyncOutcome | null = null;
    lastOk = false;
    try {
      useSyncStatus.setState({ syncing: true });
      useSyncStatus.setState(await publishCounts(store));
      out = await withSyncLock(() => engine.syncNow());
      if (stopped) return;
      useSyncStatus.setState({ online: out.error !== 'network' });
      useSyncStatus.setState(await publishCounts(store));
    } catch {
      // The store could not be read: the counts stay as they were; the next trigger tries again.
    } finally {
      if (!stopped) {
        useSyncStatus.setState({ syncing: false });
        bumpRevision();
      }
    }
    if (stopped || !out) return;
    if (out.ok) {
      lastOk = true;
      failures = 0;
      onSynced?.();
    } else if (out.error !== 'auth') {
      clearTimeout(retry);
      retry = setTimeout(() => void tick(), engine.nextDelayMs(failures));
      failures += 1;
    }
  }

  const interval = setInterval(() => void tick(), SYNC_INTERVAL_MS);
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') void tick();
  });
  void tick();

  return {
    kick,
    stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(retry);
      sub.remove();
    },
  };
}

/** The engine on the real API, tied to one signed-in identity: it never sends as someone else. */
export function engineFor(store: DeviceStore, identity: number): SyncEngine {
  const same = () => {
    if (useSession.getState().identity !== identity)
      throw new NetworkError('Signed in as someone else');
  };
  return createSyncEngine({
    store,
    async push(body: SyncBody) {
      same();
      const res = await apiWithDate('/v1/weighments/sync', {
        method: 'POST',
        body,
        idempotent: true,
        deviceTime: true,
        schema: syncResponseSchema,
      });
      return { results: res.body.results, serverDate: res.date };
    },
    async pull(cursor) {
      same();
      const q = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return api(`/v1/supervisor/tasks${q}`, { schema: tasksPageSchema });
    },
    async pullDoneToday() {
      same();
      return api('/v1/supervisor/done-today', { schema: doneTodaySchema });
    },
    now: Date.now,
    random: Math.random,
  });
}

/**
 * Keeps the signed-in supervisor's (or owner's) device store in sync while the app is open.
 * Stops on sign-out and on a person switch; the events stay in that user's store.
 */
export function useSync(): void {
  const { data: me } = useMe();
  const status = useSession((s) => s.status);
  const identity = useSession((s) => s.identity);
  const signedIn = status === 'signedIn' || status === 'locked';
  const userId = signedIn && me && CAPTURE_ROLES.includes(me.role) ? me.id : null;
  const qc = useQueryClient();

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let loop: SyncLoop | null = null;
    void openDeviceStore(userId)
      .then((store) => {
        if (stopped) return;
        useDeviceStore.setState({ store });
        // After each completed run the badge asks again (refusals show up there); same person only.
        loop = startSyncLoop(engineFor(store, identity), store, () => refreshRejections(qc, identity));
        running = loop;
      })
      .catch(() => undefined); // no store, no sync: the screens show the store as unavailable
    return () => {
      stopped = true;
      loop?.stop();
      if (running === loop) running = null;
      useDeviceStore.setState({ store: null });
      useSyncStatus.setState(IDLE);
    };
  }, [userId, identity, qc]);
}
