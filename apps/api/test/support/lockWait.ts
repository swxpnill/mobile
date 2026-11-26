import type { PoolClient } from 'pg';
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

/** Registers a request a staged test started, so a failure can wait for it to settle. */
export type Track = <T>(request: Promise<T>) => Promise<T>;

/**
 * Runs `body` on a connection of its own, inside a transaction it has begun: the holder side of
 * the pattern above. The body takes its lock, starts the requests through `track`, waits for them
 * to queue, and ends the transaction itself (commit or rollback).
 *
 * If anything throws first (say `waitForLockWaiters` times out), the connection is destroyed, not
 * returned to the pool: that ends its transaction server-side, so the lock is let go and every
 * queued request runs on. Those requests are awaited (their outcomes are irrelevant by then)
 * before the error is rethrown, so nothing outlives the test or blocks closing the pools.
 */
export async function withLockHolder<R>(
  db: Db,
  body: (holder: PoolClient, track: Track) => Promise<R>,
): Promise<R> {
  const holder = await db.$client.connect();
  const started: Promise<void>[] = [];
  const track: Track = (request) => {
    // A settled copy: also marks a rejection as handled until the body awaits the request itself.
    started.push(request.then(
      () => undefined,
      () => undefined,
    ));
    return request;
  };
  try {
    await holder.query('begin');
    const out = await body(holder, track);
    holder.release();
    return out;
  } catch (e) {
    holder.release(true);
    await Promise.all(started);
    throw e;
  }
}
