/** The SQLSTATE of a Postgres error (drizzle's wrapper or the driver's own), or null. */
export function pgCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur !== null && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return c.code;
    cur = c.cause;
  }
  return null;
}

/**
 * Contention, not a bug: deadlock_detected, serialization_failure, lock_not_available (the
 * transaction's lock_timeout). The same request is likely to succeed when sent again.
 */
export const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set(['40P01', '40001', '55P03']);

/** Drizzle wraps driver errors; the Postgres error is the `cause` (or the error itself). */
export function pgError(e: unknown): { code?: string; constraint?: string; detail?: string } | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur !== null && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; constraint?: unknown; detail?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && typeof c.constraint === 'string') {
      return { code: c.code, constraint: c.constraint, ...(typeof c.detail === 'string' ? { detail: c.detail } : {}) };
    }
    cur = c.cause;
  }
  return null;
}
