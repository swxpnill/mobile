import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useSession } from './session';

/** Fingerprint lock after this long without a touch (spec §9). */
export const LOCK_AFTER_MS = 15 * 60_000;

export function shouldLock(input: {
  enabled: boolean;
  lastActiveAt: number;
  now: number;
}): boolean {
  return input.enabled && input.now - input.lastActiveAt >= LOCK_AFTER_MS;
}

/**
 * Locks a signed-in session after 15 idle minutes when fingerprint unlock is on. Checks when the
 * app returns to the foreground and on the first touch after idling. Returns a handler for the
 * root view's `onTouchStart`.
 */
export function useIdleLock(): () => void {
  const { prefs } = useTheme();
  const lastActiveAt = useRef(Date.now());
  const enabled = prefs.fingerprint;

  const check = useCallback(() => {
    const now = Date.now();
    const { status, lock } = useSession.getState();
    if (status === 'signedIn' && shouldLock({ enabled, lastActiveAt: lastActiveAt.current, now })) {
      lock();
    }
    lastActiveAt.current = now;
  }, [enabled]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
      // Leaving the app counts as the last activity; the idle clock runs while it is closed.
      else lastActiveAt.current = Date.now();
    });
    return () => sub.remove();
  }, [check]);

  return check;
}
