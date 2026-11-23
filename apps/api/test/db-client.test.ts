import { describe, expect, inject, it } from 'vitest';
import { createDb } from '../src/db/client.ts';

describe('createDb', () => {
  it('survives the server terminating an idle pooled connection, logs it, and the next query works', async () => {
    let logged: (value: { obj: unknown; msg: string }) => void = () => {};
    const seen = new Promise<{ obj: unknown; msg: string }>((resolve) => {
      logged = resolve;
    });
    const runtime = createDb(inject('appDatabaseUrl'), {
      max: 1,
      log: { error: (obj, msg) => logged({ obj, msg }) },
    });
    const owner = createDb(inject('ownerDatabaseUrl'));
    try {
      const before = await runtime.db.$client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = before.rows[0]?.pid;
      expect(pid).toBeTypeOf('number');

      // What a Neon restart or a pooler recycling an idle connection looks like from the client.
      await owner.db.$client.query('select pg_terminate_backend($1)', [pid]);

      const { obj, msg } = await seen;
      expect(msg).toBe('database pool error');
      expect(obj).toMatchObject({ err: expect.any(Error) });

      const after = await runtime.db.$client.query<{ pid: number }>('select pg_backend_pid() as pid');
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await runtime.close();
      await owner.close();
    }
  });
});
