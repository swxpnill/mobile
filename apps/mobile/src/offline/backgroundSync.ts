import { meSchema } from '@tonnage/shared';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { useEffect } from 'react';
import { api } from '../api/client';
import { useMe } from '../api/hooks/me';
import { useSession } from '../auth/session';
import { openDeviceStore } from './sqliteDeviceStore';
import { withSyncLock } from './syncLock';
import { CAPTURE_ROLES, engineFor, isLoopRunning, syncNow } from './useSync';

/** The Android periodic task (spec §6.4, ~15 min; F5 Ruling 10). */
export const SYNC_TASK = 'tonnage-sync';
export const SYNC_TASK_MINUTES = 15;

let restoring: Promise<void> | null = null;

/**
 * One background sync for whoever is signed in on this phone. With the app open, the running
 * loop does it; with no screen up (the OS woke the app for the task), the session is restored and
 * that person's device store synced once. Never throws.
 */
export async function runBackgroundSync(): Promise<'synced' | 'skipped' | 'failed'> {
  try {
    if (useSession.getState().status === 'loading') {
      restoring ??= useSession.getState().init().finally(() => {
        restoring = null;
      });
      await restoring;
    }
    const { status, identity } = useSession.getState();
    if (status !== 'signedIn' && status !== 'locked') return 'skipped';
    if (isLoopRunning()) {
      await syncNow();
      return 'synced';
    }
    const me = await api('/v1/me', { schema: meSchema });
    if (!CAPTURE_ROLES.includes(me.role)) return 'skipped';
    const store = await openDeviceStore(me.id);
    const out = await withSyncLock(() => engineFor(store, identity).syncNow());
    return out.ok ? 'synced' : 'failed';
  } catch {
    return 'failed';
  }
}

// Defined at module load (imported from the root layout), as the OS may start the app just for it.
if (!TaskManager.isTaskDefined(SYNC_TASK)) {
  TaskManager.defineTask(SYNC_TASK, async () =>
    (await runBackgroundSync()) === 'failed' ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success,
  );
}

/**
 * Registers the periodic task. False when the OS will not run it — Expo Go reports Restricted
 * (Task 1 finding) — and then nothing is registered; foreground sync still runs.
 */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: SYNC_TASK_MINUTES });
    return true;
  } catch {
    return false;
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) await BackgroundTask.unregisterTaskAsync(SYNC_TASK);
  } catch {
    // not registered, or the OS refused: nothing left to undo
  }
}

/** Keeps the periodic task registered while a capture role is signed in on this phone. */
export function useBackgroundSync(): void {
  const { data: me } = useMe();
  const status = useSession((s) => s.status);
  const capture = (status === 'signedIn' || status === 'locked') && me !== undefined && CAPTURE_ROLES.includes(me.role);
  const known = status !== 'loading' && (status === 'signedOut' || me !== undefined);
  useEffect(() => {
    if (!known) return;
    void (capture ? registerBackgroundSync() : unregisterBackgroundSync());
  }, [capture, known]);
}
