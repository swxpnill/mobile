import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantId, timestamps } from './columns.ts';

/** No RLS: read by id only, from auth and the pipeline. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  settings: jsonb('settings').notNull(),
  ...timestamps,
});

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    gstin: text('gstin'),
    orderPrefix: text('order_prefix').notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('companies_tenant_id_id_key').on(t.tenantId, t.id),
    unique('companies_tenant_id_code_key').on(t.tenantId, t.code),
  ],
);

export const plants = pgTable(
  'plants',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    location: text('location').notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('plants_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'plants_company_fk',
      columns: [t.tenantId, t.companyId],
      foreignColumns: [companies.tenantId, companies.id],
    }),
  ],
);
