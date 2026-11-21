/**
 * The longest a run waits for the one before it. Requests time out well before this, so only a
 * run stuck for good (a hung native call) is passed: it must never stop this phone syncing.
 */
export const SYNC_LOCK_MAX_WAIT_MS = 120_000;

let tail: Promise<unknown> = Promise.resolve();

const settledOrLate = (p: Promise<unknown>) =>
  new Promise<void>((resolve) => {
    const late = setTimeout(resolve, SYNC_LOCK_MAX_WAIT_MS);
    const done = () => {
      clearTimeout(late);
      resolve();
    };
    p.then(done, done);
  });

/**
 * One sync run at a time on this phone (F5 Review Focus 3): the foreground loop and the
 * background task both go through here, first come first served. A failed run never blocks the
 * next one, and a stuck one only for `SYNC_LOCK_MAX_WAIT_MS`.
 */
export function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = settledOrLate(tail).then(fn);
  tail = run;
  return run;
}

/** Tests: forget runs left over from an earlier test. */
export function resetSyncLockForTests(): void {
  tail = Promise.resolve();
}
