/** Drizzle wraps driver errors; the Postgres error is the `cause` (or the error itself). */
export function pgError(e: unknown): { code?: string; constraint?: string } | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur !== null && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && typeof c.constraint === 'string') {
      return { code: c.code, constraint: c.constraint };
    }
    cur = c.cause;
  }
  return null;
}
