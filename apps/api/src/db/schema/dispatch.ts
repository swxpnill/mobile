import { foreignKey, pgTable, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './columns.ts';
import { tenants } from './org.ts';

/**
 * The tenant's change clock (B3 Ruling 3): strictly increasing, bumped by every write a phone's
 * task pull must see. Its row lock, held to commit, is the pull's fence: a pull that reads it
 * `for share` waits for in-flight writers, so a cursor it hands out never runs ahead of a change.
 */
export const tenantSyncClock = pgTable(
  'tenant_sync_clock',
  {
    tenantId: uuid('tenant_id').primaryKey(),
    lastChangeAt: tstz('last_change_at').notNull(),
  },
  (t) => [foreignKey({ name: 'tenant_sync_clock_tenant_fk', columns: [t.tenantId], foreignColumns: [tenants.id] })],
);
