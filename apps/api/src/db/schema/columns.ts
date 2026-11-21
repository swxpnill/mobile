import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** `timestamp with time zone`, read and written as a `Date`. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** `created_at` / `updated_at`: written by handlers from the injected Clock, never `now()`. */
export const timestamps = {
  createdAt: tstz('created_at').notNull(),
  updatedAt: tstz('updated_at').notNull(),
};

/** `tenant_id uuid not null` on every tenant-owned table (RLS keys on it, see rls.sql). */
export const tenantId = () => uuid('tenant_id').notNull();
