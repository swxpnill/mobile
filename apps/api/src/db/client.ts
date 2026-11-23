import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

/** The database handle (schema-typed drizzle on node-postgres); the pool is reachable as `db.$client`. */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** A transaction handle, as passed to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

/** Where pool-level errors go: a pino logger (the API passes its own) fits this shape. */
export interface PoolErrorLog {
  error(obj: { err: Error }, msg: string): void;
}

const consoleLog: PoolErrorLog = {
  error: (obj, msg) => console.error(msg, obj.err),
};

export function createDb(
  connectionString: string,
  opts: { max?: number; log?: PoolErrorLog } = {},
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    ...(opts.max !== undefined ? { max: opts.max } : {}),
  });
  // The server ending an idle client (restart, failover, a pooler recycling it) is emitted on the
  // pool; without a listener Node treats it as uncaught and the process dies. The pool has already
  // dropped that client, so the next query opens a fresh one: log it and carry on.
  const log = opts.log ?? consoleLog;
  pool.on('error', (err) => log.error({ err }, 'database pool error'));
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}

/**
 * Runs `fn` in a transaction scoped to one tenant: `app.tenant_id` is set transaction-locally
 * (`set_config(..., true)`), so RLS sees only that tenant's rows and the setting is gone at commit
 * or rollback, never left on the pooled connection. Given a transaction (auth, which learns the tenant
 * mid-transaction), it runs in a savepoint of it and the setting lasts until that transaction ends.
 */
export function withTenant<T>(db: Db | Tx, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
