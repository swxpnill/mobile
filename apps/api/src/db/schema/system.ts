import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantId, timestamps, tstz } from './columns.ts';
import { tenants } from './org.ts';
import { users } from './users.ts';

/** A replayable response per (user, Idempotency-Key). `status`/`body` stay null while the first request runs. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    route: text('route').notNull(),
    status: integer('status'),
    body: jsonb('body'),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [t.userId, t.key] }),
    foreignKey({
      name: 'idempotency_keys_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
  ],
);

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    orderId: uuid('order_id'),
    action: text('action').notNull(),
    actorId: uuid('actor_id').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    at: tstz('at').notNull(),
    ...timestamps,
  },
  (t) => [
    index('activity_log_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    index('activity_log_order_idx').on(t.tenantId, t.orderId),
    foreignKey({
      name: 'activity_log_actor_fk',
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);
