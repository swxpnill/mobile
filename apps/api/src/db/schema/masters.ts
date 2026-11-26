import { sql } from 'drizzle-orm';
import {
  bigint,
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Length, PartyType } from '@tonnage/shared';
import { tenantId, timestamps } from './columns.ts';
import { companies, tenants } from './org.ts';
import { users } from './users.ts';

/** Customers, brokers and transporters. Contacts, their numbers and addresses are child tables. */
export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    type: text('type').$type<PartyType>().notNull(),
    name: text('name').notNull(),
    /** Normalised (upper case); null when not registered. Unique per tenant when set. */
    gstin: text('gstin'),
    city: text('city').notNull(),
    defaultCommissionPerMt: bigint('default_commission_per_mt', { mode: 'number' }),
    paymentTermsText: text('payment_terms_text').notNull(),
    isSelfTransporter: boolean('is_self_transporter').notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('parties_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('parties_tenant_gstin_key')
      .on(t.tenantId, t.gstin)
      .where(sql`${t.gstin} is not null`),
    index('parties_tenant_type_idx').on(t.tenantId, t.type),
    check('parties_type_check', sql`${t.type} in ('customer', 'broker', 'transporter')`),
    foreignKey({
      name: 'parties_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/** A party's people, in the order the client sent them (`position`). */
export const partyContacts = pgTable(
  'party_contacts',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    roleLabel: text('role_label').notNull(),
    ...timestamps,
  },
  (t) => [
    // Also the index for loading a party's contacts (its prefix) and the target of the numbers' FK.
    unique('party_contacts_tenant_party_id_key').on(t.tenantId, t.partyId, t.id),
    foreignKey({
      name: 'party_contacts_party_fk',
      columns: [t.tenantId, t.partyId],
      foreignColumns: [parties.tenantId, parties.id],
    }).onDelete('cascade'),
  ],
);

/** A contact's phone numbers (`+91` and 10 digits). `party_id` is carried for search and counts. */
export const contactNumbers = pgTable(
  'contact_numbers',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    position: integer('position').notNull(),
    number: text('number').notNull(),
    label: text('label').notNull(),
    whatsapp: boolean('whatsapp').notNull(),
    ...timestamps,
  },
  (t) => [
    // A party's numbers (prefix) and the cascade from a deleted contact.
    index('contact_numbers_contact_idx').on(t.tenantId, t.partyId, t.contactId),
    // The number's party is its contact's party.
    foreignKey({
      name: 'contact_numbers_contact_fk',
      columns: [t.tenantId, t.partyId, t.contactId],
      foreignColumns: [partyContacts.tenantId, partyContacts.partyId, partyContacts.id],
    }).onDelete('cascade'),
  ],
);

export const partyAddresses = pgTable(
  'party_addresses',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<'bill_to' | 'ship_to'>().notNull(),
    label: text('label').notNull(),
    address: text('address').notNull(),
    isDefault: boolean('is_default').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('party_addresses_tenant_id_id_key').on(t.tenantId, t.id),
    index('party_addresses_party_idx').on(t.tenantId, t.partyId),
    // At most one default bill-to per party (the shared schema refuses it first, at addresses.i.isDefault).
    uniqueIndex('party_addresses_default_bill_to_key')
      .on(t.tenantId, t.partyId)
      .where(sql`${t.kind} = 'bill_to' and ${t.isDefault}`),
    check('party_addresses_kind_check', sql`${t.kind} in ('bill_to', 'ship_to')`),
    foreignKey({
      name: 'party_addresses_party_fk',
      columns: [t.tenantId, t.partyId],
      foreignColumns: [parties.tenantId, parties.id],
    }).onDelete('cascade'),
  ],
);

/** Products; display name and tag are derived by the shared rules, never stored. */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    category: text('category').notNull(),
    grade: text('grade').notNull(),
    sizeLabel: text('size_label').notNull(),
    conversionPerMt: bigint('conversion_per_mt', { mode: 'number' }).notNull(),
    standardLengths: jsonb('standard_lengths').$type<Length[]>().notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('products_tenant_id_id_key').on(t.tenantId, t.id),
    index('products_tenant_category_idx').on(t.tenantId, t.category),
    // One product per display name (case-insensitive), as the shared `productDisplayName` reads it:
    // category and grade joined by a space, then the size. Also what makes two racing creates safe.
    uniqueIndex('products_tenant_display_name_key').on(
      t.tenantId,
      sql`lower(btrim(${t.category} || ' ' || ${t.grade}))`,
      sql`lower(${t.sizeLabel})`,
    ),
    foreignKey({
      name: 'products_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/** Which companies sell a product, in the order the client sent them (`position`, as the mock keeps them). */
export const productCompanies = pgTable(
  'product_companies',
  {
    tenantId: tenantId().references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    companyId: uuid('company_id').notNull(),
    position: integer('position').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'product_companies_pkey', columns: [t.tenantId, t.productId, t.companyId] }),
    index('product_companies_company_idx').on(t.tenantId, t.companyId),
    foreignKey({
      name: 'product_companies_product_fk',
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'product_companies_company_fk',
      columns: [t.tenantId, t.companyId],
      foreignColumns: [companies.tenantId, companies.id],
    }),
  ],
);
