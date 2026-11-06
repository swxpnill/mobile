import * as Crypto from 'expo-crypto';
import { useRef } from 'react';
import { ApiError } from './client';

/**
 * True when the server definitely finished with this key (success or a 4xx refusal), so the next
 * submit is a new request. A network failure, timeout or 5xx may have been applied anyway, and
 * `IDEMPOTENCY_IN_PROGRESS` means the first try is still running: in those cases the next tap must
 * reuse the key so the server replays the first result instead of creating a second record.
 */
export function answered(e?: unknown): boolean {
  if (e === undefined) return true;
  if (!(e instanceof ApiError)) return false;
  if (e.code === 'IDEMPOTENCY_IN_PROGRESS') return false;
  return e.status >= 400 && e.status < 500;
}

/** One `Idempotency-Key` per form submit, kept across retries of that submit (spec §5.7). */
export function useSubmitKey(): { key(): string; settle(e?: unknown): void } {
  const ref = useRef<string | null>(null);
  const api = useRef({
    key() {
      ref.current ??= Crypto.randomUUID();
      return ref.current;
    },
    settle(e?: unknown) {
      if (answered(e)) ref.current = null;
    },
  });
  return api.current;
}

/**
 * Runs at most one submit at a time. Two taps in the same frame both reach onPress before the
 * button re-renders as busy; the second is dropped here (otherwise it would go back twice).
 */
export function createSingleFlight(): (fn: () => Promise<unknown>) => Promise<void> {
  let busy = false;
  return async (fn) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };
}

/** One single-flight runner kept for the life of the screen. */
export function useSingleFlight(): (fn: () => Promise<unknown>) => Promise<void> {
  const run = useRef<ReturnType<typeof createSingleFlight> | null>(null);
  run.current ??= createSingleFlight();
  return run.current;
}
