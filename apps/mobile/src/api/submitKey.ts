import * as Crypto from 'expo-crypto';
import { useRef } from 'react';
import { ApiError } from './client';

/**
 * True when the server definitely answered (success or a 4xx refusal), so the next submit is a new
 * request. A network failure, timeout or 5xx may have been applied anyway: the next tap must reuse
 * the key so the server replays the first result instead of creating a second user or company.
 */
export function answered(e?: unknown): boolean {
  if (e === undefined) return true;
  return e instanceof ApiError && e.status >= 400 && e.status < 500;
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
