import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useSession } from './session';

/** Fingerprint lock after this long without a touch (spec §9). */
export const LOCK_AFTER_MS = 15 * 60_000;
/** How often an open, untouched app checks whether it should lock. */
const FOREGROUND_CHECK_MS = 30_000;

export function shouldLock(input: {
  enabled: boolean;
  lastActiveAt: number;
  now: number;
}): boolean {
  return input.enabled && input.now - input.lastActiveAt >= LOCK_AFTER_MS;
}

/**
 * Locks a signed-in session after 15 minutes without a touch when fingerprint unlock is on.
 * The last touch is the last activity: time on an idle screen and time in the background both
 * count. Checked on every touch, when the app returns to the foreground, and every 30 s while it
 * is open. (A cold start with fingerprint on always starts locked — see session.init.)
 * Returns the handler for the root view's `onTouchStart`.
 */
export function useIdleLock(): () => void {
  const { prefs } = useTheme();
  const lastActiveAt = useRef(Date.now());
  const enabled = prefs.fingerprint;

  const lockIfIdle = useCallback(() => {
    const { status, lock } = useSession.getState();
    if (status !== 'signedIn') return false;
    if (shouldLock({ enabled, lastActiveAt: lastActiveAt.current, now: Date.now() })) {
      lock();
      return true;
    }
    return false;
  }, [enabled]);

  const onActivity = useCallback(() => {
    if (!lockIfIdle()) lastActiveAt.current = Date.now();
  }, [lockIfIdle]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') lockIfIdle();
    });
    const timer = setInterval(lockIfIdle, FOREGROUND_CHECK_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [lockIfIdle]);

  // Unlocking (or signing in) is activity: the idle clock starts again from there.
  useEffect(
    () =>
      useSession.subscribe((s, prev) => {
        if (s.status === 'signedIn' && prev.status !== 'signedIn')
          lastActiveAt.current = Date.now();
      }),
    [],
  );

  return onActivity;
}
