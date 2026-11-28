import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';

/**
 * Moves the tenant's change clock to `now`, or 1 ms past its last value when the clock has not
 * moved on (B3 Ruling 3), and returns it as ISO: the `updated_at` / `removed_at` / `resolved_at`
 * of what this transaction writes for phones. Lock order 1: call it before any other truck write.
 */
export async function bumpChangeClock(tx: Tx, tenantId: string, now: number): Promise<string> {
  const res = await tx.execute<{ at: Date | string }>(sql`
    insert into tenant_sync_clock (tenant_id, last_change_at)
    values (${tenantId}, ${new Date(now).toISOString()}::timestamptz)
    on conflict (tenant_id) do update
      set last_change_at = greatest(tenant_sync_clock.last_change_at + interval '1 millisecond', excluded.last_change_at)
    returning last_change_at as at`);
  return toIso(res.rows[0]!.at);
}

/**
 * The tenant's last change time, read `for share`: waits until every transaction that bumped it has
 * committed, so everything changed up to the returned time is visible to the next statement. Null
 * before the tenant's first change.
 */
export async function readChangeClockForShare(tx: Tx, tenantId: string): Promise<string | null> {
  const res = await tx.execute<{ at: Date | string }>(
    sql`select last_change_at as at from tenant_sync_clock where tenant_id = ${tenantId} for share`,
  );
  const row = res.rows[0];
  return row ? toIso(row.at) : null;
}

const toIso = (v: Date | string): string => new Date(v).toISOString();
