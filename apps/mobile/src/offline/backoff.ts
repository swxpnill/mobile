/** Retry delay ceiling (plan Ruling 5): 5 minutes. */
export const MAX_BACKOFF_MS = 300_000;

/**
 * Delay before the next sync attempt after `failures` failures in a row: 2 s × 2ⁿ, ±20 % jitter
 * (`random` in [0, 1)), never more than 5 minutes — the cap applies after the jitter too.
 */
export function backoff(failures: number, random: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, failures));
  return Math.min(MAX_BACKOFF_MS, Math.round(base * (0.8 + 0.4 * random)));
}
