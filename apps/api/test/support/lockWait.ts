import type { Db } from '../../src/db/client.ts';

/**
 * Resolves once at least `n` backends of this test database are waiting on a lock; rejects after
 * `timeoutMs` (default 10 s). Polled on the admin pool, its own connection: inside a transaction
 * pg_stat_activity would be a snapshot. Only this database counts, so another test database on the
 * same cluster never satisfies it.
 *
 * The deterministic concurrency pattern: hold a row lock on a separate connection, start the
 * requests, wait here until they are all queued behind it, then let go.
 */
export async function waitForLockWaiters(
  adminDb: Db,
  n: number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  for (;;) {
    const res = await adminDb.$client.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    waiting = res.rows[0]?.n ?? 0;
    if (waiting >= n) return;
    if (Date.now() >= deadline) {
      throw new Error(`only ${waiting} of ${n} backends were waiting on a lock after ${timeoutMs} ms`);
    }
  }
}
