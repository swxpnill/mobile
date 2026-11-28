import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
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
import type { EarningLine, SyncEvent, SyncRejectCode, TruckState, VehicleRequestChannel } from '@tonnage/shared';
import { tenantId, timestamps, tstz } from './columns.ts';
import { parties } from './masters.ts';
import { orderLines, orders, subOrders, trucks } from './orders.ts';
import { plants, tenants } from './org.ts';
import { users } from './users.ts';

const int8 = (name: string) => bigint(name, { mode: 'number' });

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

/**
 * Every weight reading of a truck (§4, the mock's `WeighmentRec`). A sync event's reading carries
 * its client event id (unique in the tenant); an office correction's readings carry none. A
 * corrected reading points at the one that replaced it (`superseded_by`).
 */
export const weighments = pgTable(
  'weighments',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    truckId: uuid('truck_id').notNull(),
    kind: text('kind').$type<'tare' | 'gross'>().notNull(),
    kg: int8('kg').notNull(),
    enteredBy: uuid('entered_by').notNull(),
    deviceId: text('device_id').notNull(),
    clientEventId: uuid('client_event_id'),
    capturedAtDevice: tstz('captured_at_device').notNull(),
    /** Business time: the device time corrected by its clock offset (§6.6). */
    capturedAt: tstz('captured_at').notNull(),
    receivedAt: tstz('received_at').notNull(),
    clockSkewFlag: boolean('clock_skew_flag').notNull(),
    supersededBy: uuid('superseded_by'),
    ...timestamps,
  },
  (t) => [
    unique('weighments_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('weighments_tenant_client_event_key')
      .on(t.tenantId, t.clientEventId)
      .where(sql`${t.clientEventId} is not null`),
    index('weighments_tenant_truck_idx').on(t.tenantId, t.truckId),
    check('weighments_kind_check', sql`${t.kind} in ('tare', 'gross')`),
    check('weighments_kg_check', sql`${t.kg} >= 0`),
    foreignKey({ name: 'weighments_truck_fk', columns: [t.tenantId, t.truckId], foreignColumns: [trucks.tenantId, trucks.id] }).onDelete('cascade'),
    foreignKey({ name: 'weighments_entered_by_fk', columns: [t.tenantId, t.enteredBy], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({
      name: 'weighments_superseded_by_fk',
      columns: [t.tenantId, t.supersededBy],
      foreignColumns: [t.tenantId, t.id],
    }),
  ],
);

/**
 * A sync event already seen (the mock's `AppliedEventRec`): what de-duplication needs and nothing
 * else. A refusal keeps its code and generic message, so a replay is refused again the same way.
 * Inserting the row is the event's claim (B3 Ruling 4).
 */
export const syncEvents = pgTable(
  'sync_events',
  {
    tenantId: tenantId().references(() => tenants.id),
    clientEventId: uuid('client_event_id').notNull(),
    userId: uuid('user_id').notNull(),
    truckId: uuid('truck_id').notNull(),
    status: text('status').$type<'accepted' | 'rejected'>().notNull(),
    code: text('code').$type<SyncRejectCode>(),
    message: text('message'),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'sync_events_pkey', columns: [t.tenantId, t.clientEventId] }),
    check('sync_events_status_check', sql`${t.status} in ('accepted', 'rejected')`),
    check('sync_events_refusal_check', sql`(${t.status} = 'rejected') = (${t.code} is not null)`),
    foreignKey({ name: 'sync_events_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
  ],
);

/** A refused sync event, kept so no weight is ever lost (§6.5 Needs attention). */
export const weighmentRejections = pgTable(
  'weighment_rejections',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    clientEventId: uuid('client_event_id').notNull(),
    truckId: uuid('truck_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: text('device_id').notNull(),
    /** The sending phone's clock offset (server − device), so a restore keeps the event's business time. */
    offsetMs: int8('offset_ms').notNull(),
    event: jsonb('event').$type<SyncEvent>().notNull(),
    code: text('code').$type<SyncRejectCode>().notNull(),
    serverState: text('server_state').$type<TruckState>().notNull(),
    status: text('status').$type<'open' | 'restored' | 'dismissed'>().notNull(),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: tstz('resolved_at'),
    resolutionNote: text('resolution_note'),
    ...timestamps,
  },
  (t) => [
    unique('weighment_rejections_tenant_id_id_key').on(t.tenantId, t.id),
    index('weighment_rejections_tenant_status_idx').on(t.tenantId, t.status),
    index('weighment_rejections_tenant_user_resolved_idx').on(t.tenantId, t.userId, t.resolvedAt),
    index('weighment_rejections_tenant_truck_idx').on(t.tenantId, t.truckId),
    check('weighment_rejections_status_check', sql`${t.status} in ('open', 'restored', 'dismissed')`),
    foreignKey({
      name: 'weighment_rejections_truck_fk',
      columns: [t.tenantId, t.truckId],
      foreignColumns: [trucks.tenantId, trucks.id],
    }).onDelete('cascade'),
    foreignKey({ name: 'weighment_rejections_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
    foreignKey({
      name: 'weighment_rejections_resolved_by_fk',
      columns: [t.tenantId, t.resolvedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/**
 * A truck purged with its order (hard delete), so a phone's cursor pull can drop its task. No PII.
 * The truck row is gone, so there is no truck FK; the plant FK keeps it in the tenant.
 */
export const truckTombstones = pgTable(
  'truck_tombstones',
  {
    tenantId: tenantId().references(() => tenants.id),
    truckId: uuid('truck_id').notNull(),
    plantId: uuid('plant_id').notNull(),
    reason: text('reason').$type<'gone' | 'deleted'>().notNull(),
    removedAt: tstz('removed_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'truck_tombstones_pkey', columns: [t.tenantId, t.truckId] }),
    index('truck_tombstones_tenant_plant_removed_idx').on(t.tenantId, t.plantId, t.removedAt),
    check('truck_tombstones_reason_check', sql`${t.reason} in ('gone', 'deleted')`),
    foreignKey({ name: 'truck_tombstones_plant_fk', columns: [t.tenantId, t.plantId], foreignColumns: [plants.tenantId, plants.id] }),
  ],
);

/**
 * The append-only broker ledger (§4, §5.4; the mock's `BrokerLedgerRec`): earnings positive, a
 * payment −(paid + TDS), a reversal the exact negation of the row it reverses. B3 writes earnings and
 * reversals at dispatch and correction (Ruling 5); B4 adds payments. Hard delete is the only removal.
 */
export const brokerLedger = pgTable(
  'broker_ledger',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    brokerId: uuid('broker_id').notNull(),
    kind: text('kind').$type<'earning' | 'payment' | 'reversal'>().notNull(),
    truckId: uuid('truck_id'),
    amountRupees: int8('amount_rupees').notNull(),
    breakdown: jsonb('breakdown').$type<EarningLine[]>().notNull(),
    reversesId: uuid('reverses_id'),
    createdAt: tstz('created_at').notNull(),
    createdBy: uuid('created_by').notNull(),
    mode: text('mode').$type<'neft' | 'upi' | 'cash' | 'cheque'>(),
    utr: text('utr'),
    tdsRupees: int8('tds_rupees'),
    paidRupees: int8('paid_rupees'),
    /** IST date a payment counts on. */
    paidOn: date('paid_on', { mode: 'string' }),
    note: text('note'),
  },
  (t) => [
    unique('broker_ledger_tenant_id_id_key').on(t.tenantId, t.id),
    index('broker_ledger_tenant_broker_created_idx').on(t.tenantId, t.brokerId, t.createdAt),
    index('broker_ledger_tenant_truck_idx').on(t.tenantId, t.truckId),
    uniqueIndex('broker_ledger_one_reversal_key')
      .on(t.tenantId, t.reversesId)
      .where(sql`${t.reversesId} is not null`),
    check('broker_ledger_kind_check', sql`${t.kind} in ('earning', 'payment', 'reversal')`),
    check('broker_ledger_reversal_check', sql`(${t.kind} = 'reversal') = (${t.reversesId} is not null)`),
    check('broker_ledger_mode_check', sql`${t.mode} is null or ${t.mode} in ('neft', 'upi', 'cash', 'cheque')`),
    foreignKey({ name: 'broker_ledger_broker_fk', columns: [t.tenantId, t.brokerId], foreignColumns: [parties.tenantId, parties.id] }),
    foreignKey({ name: 'broker_ledger_truck_fk', columns: [t.tenantId, t.truckId], foreignColumns: [trucks.tenantId, trucks.id] }),
    foreignKey({ name: 'broker_ledger_reverses_fk', columns: [t.tenantId, t.reversesId], foreignColumns: [t.tenantId, t.id] }),
    foreignKey({ name: 'broker_ledger_created_by_fk', columns: [t.tenantId, t.createdBy], foreignColumns: [users.tenantId, users.id] }),
  ],
);

/** A request to a customer or broker to send a truck (the mock's `VehicleRequestRec`). */
export const vehicleRequests = pgTable(
  'vehicle_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    partyId: uuid('party_id').notNull(),
    partyName: text('party_name').notNull(),
    contactName: text('contact_name').notNull(),
    number: text('number').notNull(),
    channel: text('channel').$type<VehicleRequestChannel>().notNull(),
    totalKg: int8('total_kg').notNull(),
    requestedAt: tstz('requested_at').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('vehicle_requests_tenant_id_id_key').on(t.tenantId, t.id),
    index('vehicle_requests_tenant_order_idx').on(t.tenantId, t.orderId),
    check('vehicle_requests_total_kg_check', sql`${t.totalKg} > 0`),
    foreignKey({ name: 'vehicle_requests_order_fk', columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }).onDelete('cascade'),
    foreignKey({ name: 'vehicle_requests_party_fk', columns: [t.tenantId, t.partyId], foreignColumns: [parties.tenantId, parties.id] }),
    foreignKey({ name: 'vehicle_requests_requested_by_fk', columns: [t.tenantId, t.requestedBy], foreignColumns: [users.tenantId, users.id] }),
  ],
);

/** The lines of a vehicle request, in the order sent. */
export const vehicleRequestLines = pgTable(
  'vehicle_request_lines',
  {
    tenantId: tenantId().references(() => tenants.id),
    requestId: uuid('request_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    subOrderId: uuid('sub_order_id').notNull(),
    position: integer('position').notNull(),
    kg: int8('kg').notNull(),
  },
  (t) => [
    primaryKey({ name: 'vehicle_request_lines_pkey', columns: [t.tenantId, t.requestId, t.orderLineId] }),
    check('vehicle_request_lines_kg_check', sql`${t.kg} > 0`),
    foreignKey({
      name: 'vehicle_request_lines_request_fk',
      columns: [t.tenantId, t.requestId],
      foreignColumns: [vehicleRequests.tenantId, vehicleRequests.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vehicle_request_lines_line_fk',
      columns: [t.tenantId, t.orderLineId],
      foreignColumns: [orderLines.tenantId, orderLines.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vehicle_request_lines_sub_order_fk',
      columns: [t.tenantId, t.subOrderId],
      foreignColumns: [subOrders.tenantId, subOrders.id],
    }).onDelete('cascade'),
  ],
);

