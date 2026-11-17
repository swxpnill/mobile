/** Runs `fn` after every write queued before it has settled; resolves or rejects as `fn` does. */
export type WriteQueue = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A promise-chain mutex: writes run one at a time, in call order. A failed write rejects only its
 * own caller; the chain goes on. The SQLite device store sends every write through one, so its
 * exclusive transactions (each on a connection of its own) never contend for the lock.
 */
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };
}
