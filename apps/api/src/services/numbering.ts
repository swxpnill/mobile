import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';

/** Series keys in `number_series`: the mock's `nextNumber` keys, so both number alike. */
export const ORDER_SERIES = 'order';

/**
 * The next number of a per-tenant series for one IST financial year (Ruling 5), 1 for a new year.
 * One statement: the upsert takes the series row's lock and bumps it, so concurrent callers queue
 * on that row and each gets a distinct number; the lock is held to the end of the caller's
 * transaction. A rolled-back transaction leaves a gap (the spec tolerates gaps, never duplicates).
 *
 * The tenant is the request's (`app.tenant_id`, the setting row-level security checks the row
 * against); `at` stamps the row from the injected clock. The FY label comes from the shared
 * `financialYear` rule, never computed here.
 */
export async function nextNumber(tx: Tx, key: string, fy: string, at: number): Promise<number> {
  const stamp = new Date(at);
  const res = await tx.execute<{ n: string | number }>(sql`
    insert into number_series (tenant_id, series_key, fy, next_value, created_at, updated_at)
    values (current_setting('app.tenant_id')::uuid, ${key}, ${fy}, 2, ${stamp}, ${stamp})
    on conflict (tenant_id, series_key, fy)
    do update set next_value = number_series.next_value + 1, updated_at = excluded.updated_at
    returning next_value - 1 as n`);
  const n = Number(res.rows[0]?.n);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`number_series returned ${String(res.rows[0]?.n)}`);
  return n;
}
