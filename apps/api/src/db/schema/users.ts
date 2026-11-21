import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Role, UnitBasis } from '@tonnage/shared';
import { tenantId, timestamps, tstz } from './columns.ts';
import { plants, tenants } from './org.ts';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    name: text('name').notNull(),
    mobile: text('mobile').notNull(),
    role: text('role').$type<Role>().notNull(),
    active: boolean('active').notNull().default(true),
    invitedAt: tstz('invited_at').notNull(),
    lastSeenAt: tstz('last_seen_at'),
    preferences: jsonb('preferences')
      .$type<{ unitBasis: UnitBasis }>()
      .notNull()
      .default({ unitBasis: 'mt' }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('users_tenant_id_mobile_key').on(t.tenantId, t.mobile),
    unique('users_tenant_id_id_key').on(t.tenantId, t.id),
    index('users_mobile_idx').on(t.mobile),
    check(
      'users_role_check',
      sql`${t.role} in ('owner', 'city_staff', 'plant_head', 'supervisor')`,
    ),
  ],
);

export const userPlants = pgTable(
  'user_plants',
  {
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    plantId: uuid('plant_id').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'user_plants_pkey', columns: [t.userId, t.plantId] }),
    index('user_plants_plant_idx').on(t.plantId),
    foreignKey({
      name: 'user_plants_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'user_plants_plant_fk',
      columns: [t.tenantId, t.plantId],
      foreignColumns: [plants.tenantId, plants.id],
    }).onDelete('cascade'),
  ],
);

/** One row per phone; `id` is the app's deviceId. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    pushToken: text('push_token'),
    appVersion: text('app_version'),
    lastSeenAt: tstz('last_seen_at').notNull(),
    ...timestamps,
  },
  (t) => [
    index('devices_user_idx').on(t.userId),
    foreignKey({
      name: 'devices_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);
