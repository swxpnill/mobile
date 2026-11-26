import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTransaction } from 'drizzle-orm/pg-core';
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

/** Per-transaction limits: how long to wait for a lock, and how long one statement may run (ms). */
export interface DbTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

/** The env defaults; a database the app did not configure (scripts, tests) uses these. */
export const DEFAULT_DB_TIMEOUTS: DbTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 };

const configuredTimeouts = new WeakMap<object, DbTimeouts>();

/** Sets the timeouts every `withTenant` transaction on `db` starts with (the API passes its env). */
export function configureTimeouts(db: Db, timeouts: DbTimeouts): void {
  configuredTimeouts.set(db, timeouts);
}

/**
 * Runs `fn` in a transaction scoped to one tenant: `app.tenant_id` is set transaction-locally
 * (`set_config(..., true)`), so RLS sees only that tenant's rows and the setting is gone at commit
 * or rollback, never left on the pooled connection.
 *
 * Given a transaction (auth, which learns the tenant mid-transaction), it runs in a savepoint of it.
 * A transaction-local setting outlives a released savepoint, so the caller's previous value ('' when
 * it had none) is put back afterwards, whether `fn` returned or threw: the outer transaction never
 * goes on as another tenant by accident.
 */
export async function withTenant<T>(db: Db | Tx, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!(db instanceof PgTransaction)) {
    // A new transaction also gets its lock and statement timeouts (as SET LOCAL), so a request never
    // waits on a lock or a runaway statement for ever; the pooled connection keeps its own settings.
    const { lockTimeoutMs, statementTimeoutMs } = configuredTimeouts.get(db) ?? DEFAULT_DB_TIMEOUTS;
    return db.transaction((tx) =>
      tx
        .execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true),
                     set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
                     set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`,
        )
        .then(() => fn(tx)),
    );
  }
  const run = (tx: Tx): Promise<T> =>
    tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`).then(() => fn(tx));

  const current = await db.execute<{ v: string | null }>(
    sql`select current_setting('app.tenant_id', true) as v`,
  );
  const previous = current.rows[0]?.v ?? '';
  try {
    return await db.transaction(run);
  } finally {
    await db.execute(sql`select set_config('app.tenant_id', ${previous}, true)`);
  }
}
