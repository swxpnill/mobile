import {
  type Role,
  type SyncBody,
  NetworkError,
  doneTodaySchema,
  syncResponseSchema,
  tasksPageSchema,
} from '@tonnage/shared';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { api, apiWithDate } from '../api/client';
import { useMe } from '../api/hooks/me';
import { useSession } from '../auth/session';
import type { DeviceStore } from './deviceStore';
import { openDeviceStore } from './sqliteDeviceStore';
import { type SyncEngine, type SyncOutcome, createSyncEngine } from './syncEngine';

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

/** The signed-in user's device store while the sync loop runs; null otherwise. */
export const useDeviceStore = create<{ store: DeviceStore | null }>(() => ({ store: null }));

let running: SyncLoop | null = null;

/** Sync now (after a local save). Does nothing when no loop runs. */
export function requestSync(): void {
  running?.kick();
}

export interface SyncLoop {
  kick(): void;
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
export function startSyncLoop(engine: SyncEngine, store: DeviceStore): SyncLoop {
  let stopped = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  let inFlight: Promise<void> | null = null;

  /** Triggers that arrive while a run is out share it; only that run handles its outcome. */
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function run(): Promise<void> {
    clearTimeout(retry);
    retry = undefined;
    let out: SyncOutcome | null = null;
    try {
      useSyncStatus.setState({ syncing: true });
      useSyncStatus.setState(await publishCounts(store));
      out = await engine.syncNow();
      if (stopped) return;
      useSyncStatus.setState({ online: out.error !== 'network' });
      useSyncStatus.setState(await publishCounts(store));
    } catch {
      // The store could not be read: the counts stay as they were; the next trigger tries again.
    } finally {
      if (!stopped) useSyncStatus.setState({ syncing: false });
    }
    if (stopped || !out) return;
    if (out.ok) {
      failures = 0;
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
    kick: () => void tick(),
    stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(retry);
      sub.remove();
    },
  };
}

/** The engine on the real API, tied to one signed-in identity: it never sends as someone else. */
function engineFor(store: DeviceStore, identity: number): SyncEngine {
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

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let loop: SyncLoop | null = null;
    void openDeviceStore(userId)
      .then((store) => {
        if (stopped) return;
        useDeviceStore.setState({ store });
        loop = startSyncLoop(engineFor(store, identity), store);
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
  }, [userId, identity]);
}
