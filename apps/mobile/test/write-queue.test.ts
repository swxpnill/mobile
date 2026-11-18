import { createWriteQueue } from '../src/offline/writeQueue';
import { createSqliteDeviceStore } from '../src/offline/sqliteDeviceStore';

describe('write queue (one SQLite writer at a time)', () => {
  it('runs writes one after another, in call order, even when an earlier one is slower', async () => {
    const serial = createWriteQueue();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = serial(async () => {
      log.push('first start');
      await gate;
      log.push('first end');
      return 1;
    });
    const second = serial(async () => {
      log.push('second start');
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['first start']); // the second waits for the first
    release();

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(log).toEqual(['first start', 'first end', 'second start']);
  });

  it('a failing write rejects its own caller and the next write still runs', async () => {
    const serial = createWriteQueue();
    const failed = serial(async () => {
      throw new Error('SQLITE_CONSTRAINT');
    });
    const next = serial(async () => 'ok');

    await expect(failed).rejects.toThrow('SQLITE_CONSTRAINT');
    await expect(next).resolves.toBe('ok');
    await expect(serial(async () => 'still ok')).resolves.toBe('still ok');
  });
});

describe('SQLite device store writes', () => {
  /** A fake database that counts writers in progress (top-level writes only, not inside a transaction). */
  function fakeDb() {
    const seen = { writers: 0, maxWriters: 0, txFirst: [] as string[] };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const meta = { cursor: null, clock_offset_ms: 0, last_sync_at: null, next_device_seq: 0, device_id: 'd' };
    const reads = {
      getFirstAsync: async (sql: string) => (sql.includes('sync_meta') ? meta : null),
      getAllAsync: async () => [],
    };
    const inner = {
      ...reads,
      execAsync: async (sql: string) => void (await tick(), sql),
      runAsync: async () => (await tick(), { changes: 0, lastInsertRowId: 0 }),
    };
    const write = async <T>(fn: () => Promise<T>): Promise<T> => {
      seen.writers += 1;
      seen.maxWriters = Math.max(seen.maxWriters, seen.writers);
      try {
        await tick();
        return await fn();
      } finally {
        seen.writers -= 1;
      }
    };
    const db = {
      ...reads,
      execAsync: (sql: string) => write(() => inner.execAsync(sql)),
      runAsync: () => write(() => inner.runAsync()),
      withExclusiveTransactionAsync: (fn: (tx: unknown) => Promise<void>) =>
        write(async () => {
          const sqls: string[] = [];
          await fn({ ...inner, execAsync: async (sql: string) => void sqls.push(sql), runAsync: async (sql: string) => (sqls.push(sql), inner.runAsync()) });
          seen.txFirst.push(sqls[0] ?? '');
        }),
    };
    return { db, seen };
  }

  it('never run two writes at once, and each exclusive transaction sets busy_timeout first', async () => {
    const { db, seen } = fakeDb();
    const store = await createSqliteDeviceStore(db as never, { newId: () => 'd' });
    seen.maxWriters = 0;

    await Promise.all([
      store.replaceTasks({ items: [], removed: [], resolved: [], deleted: [], cursor: 'c', serverTime: 'c' }),
      store.setMeta({ cursor: 'c2' }),
      store.markSending(['e1']),
      store.setDoneToday({ items: [], totalNetKg: 0 }),
      store.markResults([]),
      store.clear(),
    ]);

    expect(seen.maxWriters).toBe(1);
    expect(seen.txFirst).toEqual(['PRAGMA busy_timeout = 5000', 'PRAGMA busy_timeout = 5000', 'PRAGMA busy_timeout = 5000']);
  });
});
