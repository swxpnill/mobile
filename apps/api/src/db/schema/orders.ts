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
import type { CloseKind, Length, OrderType, PricingMethod, TruckState } from '@tonnage/shared';
import { tenantId, timestamps, tstz } from './columns.ts';
import { parties, partyAddresses, products } from './masters.ts';
import { companies, plants, tenants } from './org.ts';
import { users } from './users.ts';

/** Quantities (kg) and money (₹, ₹/MT) are integers, read and written as JS numbers. */
const int8 = (name: string) => bigint(name, { mode: 'number' });

/** The order header (§4). Status is derived from its lines and trucks, never stored (§5.3). */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    /** `SO-YYMM-NNNN`, from `number_series` (Ruling 5). */
    number: text('number').notNull(),
    type: text('type').$type<OrderType>().notNull(),
    customerId: uuid('customer_id'),
    brokerId: uuid('broker_id'),
    /** Broker commission fixed at booking (§5.4); null without a broker. */
    commissionPerMtSnapshot: int8('commission_per_mt_snapshot'),
    billToId: uuid('bill_to_id'),
    shipToId: uuid('ship_to_id'),
    pricingMethod: text('pricing_method').$type<PricingMethod>().notNull(),
    basicRate: int8('basic_rate'),
    notifyCustomer: boolean('notify_customer').notNull(),
    notifyBroker: boolean('notify_broker').notNull(),
    /** How many sub-order suffixes were ever handed out (A = 1); a removed one is never reused. */
    suffixesUsed: integer('suffixes_used').notNull(),
    createdBy: uuid('created_by').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('orders_tenant_id_id_key').on(t.tenantId, t.id),
    unique('orders_tenant_number_key').on(t.tenantId, t.number),
    // The list (newest first) and its cursor.
    index('orders_tenant_created_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    // Party figures and the foreign keys' referencing side (an address or party delete checks them).
    index('orders_tenant_customer_idx').on(t.tenantId, t.customerId),
    index('orders_tenant_broker_idx').on(t.tenantId, t.brokerId),
    index('orders_tenant_bill_to_idx').on(t.tenantId, t.billToId),
    index('orders_tenant_ship_to_idx').on(t.tenantId, t.shipToId),
    check('orders_type_check', sql`${t.type} in ('customer_broker', 'customer', 'broker_only')`),
    check('orders_pricing_method_check', sql`${t.pricingMethod} in ('basic_conversion', 'direct')`),
    foreignKey({
      name: 'orders_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'orders_broker_fk',
      columns: [t.tenantId, t.brokerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // An address an order points at cannot be deleted (a party PATCH maps this to 409 PARTY_IN_USE).
    foreignKey({
      name: 'orders_bill_to_fk',
      columns: [t.tenantId, t.billToId],
      foreignColumns: [partyAddresses.tenantId, partyAddresses.id],
    }),
    foreignKey({
      name: 'orders_ship_to_fk',
      columns: [t.tenantId, t.shipToId],
      foreignColumns: [partyAddresses.tenantId, partyAddresses.id],
    }),
    foreignKey({
      name: 'orders_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/** One company's part of an order: `-A`, `-B`, … in the order companies were added. */
export const subOrders = pgTable(
  'sub_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    companyId: uuid('company_id').notNull(),
    suffix: text('suffix').notNull(),
    closeKind: text('close_kind').$type<CloseKind>(),
    closeReason: text('close_reason'),
    closeNote: text('close_note'),
    closedAt: tstz('closed_at'),
    closedBy: uuid('closed_by'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('sub_orders_tenant_id_id_key').on(t.tenantId, t.id),
    // Loading an order's sub-orders (its prefix) and the target of the trucks' foreign key.
    unique('sub_orders_tenant_order_id_key').on(t.tenantId, t.orderId, t.id),
    unique('sub_orders_tenant_order_suffix_key').on(t.tenantId, t.orderId, t.suffix),
    index('sub_orders_tenant_company_idx').on(t.tenantId, t.companyId),
    check('sub_orders_close_kind_check', sql`${t.closeKind} in ('short_close', 'cancel', 'tolerance')`),
    foreignKey({
      name: 'sub_orders_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sub_orders_company_fk',
      columns: [t.tenantId, t.companyId],
      foreignColumns: [companies.tenantId, companies.id],
    }),
    foreignKey({
      name: 'sub_orders_closed_by_fk',
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/** A product line of a sub-order, priced at booking (rate and conversion are snapshots, §5.4). */
export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    subOrderId: uuid('sub_order_id').notNull(),
    /** Creation order within the sub-order (the mock's array order); a new line takes max + 1. */
    position: integer('position').notNull(),
    productId: uuid('product_id').notNull(),
    length: jsonb('length').$type<Length>().notNull(),
    orderedKg: int8('ordered_kg').notNull(),
    basicRateSnapshot: int8('basic_rate_snapshot'),
    conversionSnapshot: int8('conversion_snapshot').notNull(),
    rate: int8('rate').notNull(),
    rateEdited: boolean('rate_edited').notNull(),
    overpricePerMt: int8('overprice_per_mt').notNull(),
    closedKg: int8('closed_kg').notNull().default(0),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('order_lines_tenant_id_id_key').on(t.tenantId, t.id),
    index('order_lines_tenant_sub_order_idx').on(t.tenantId, t.subOrderId, t.position),
    // "Is this product used?" (products DELETE) and the product foreign key's referencing side.
    index('order_lines_tenant_product_idx').on(t.tenantId, t.productId),
    check('order_lines_ordered_kg_check', sql`${t.orderedKg} > 0`),
    check('order_lines_closed_kg_check', sql`${t.closedKg} >= 0`),
    foreignKey({
      name: 'order_lines_sub_order_fk',
      columns: [t.tenantId, t.subOrderId],
      foreignColumns: [subOrders.tenantId, subOrders.id],
    }).onDelete('cascade'),
    // Never cascades: a product used by a line cannot be deleted (409 PRODUCT_IN_USE).
    foreignKey({
      name: 'order_lines_product_fk',
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);

/** Saved wizard state (§5.3): no number, versioned, purged 7 days after the last save. */
export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    createdBy: uuid('created_by').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('drafts_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    index('drafts_tenant_created_by_idx').on(t.tenantId, t.createdBy),
    foreignKey({
      name: 'drafts_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/**
 * Running numbers per tenant, series and IST financial year (Ruling 5). `next_value` is the number
 * the next caller gets; the row is taken and bumped in one upsert, under its row lock.
 */
export const numberSeries = pgTable(
  'number_series',
  {
    tenantId: tenantId().references(() => tenants.id),
    seriesKey: text('series_key').notNull(),
    /** "2026-27". */
    fy: text('fy').notNull(),
    nextValue: int8('next_value').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'number_series_pkey', columns: [t.tenantId, t.seriesKey, t.fy] }),
    check('number_series_next_value_check', sql`${t.nextValue} >= 1`),
  ],
);

/** A truck on a sub-order, from assignment to dispatch (Ruling 2: the final shape; routes in B3). */
export const trucks = pgTable(
  'trucks',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId().references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    subOrderId: uuid('sub_order_id').notNull(),
    plantId: uuid('plant_id').notNull(),
    vehicleNo: text('vehicle_no').notNull(),
    transporterId: uuid('transporter_id'),
    driverName: text('driver_name').notNull(),
    driverPhone: text('driver_phone').notNull(),
    lrNo: text('lr_no'),
    state: text('state').$type<TruckState>().notNull(),
    /** Current (non-superseded) tare; the weighments (B3) keep every reading. */
    tareKg: int8('tare_kg'),
    grossKg: int8('gross_kg'),
    loadingSlipNo: text('loading_slip_no'),
    assignedAt: tstz('assigned_at').notNull(),
    assignedBy: uuid('assigned_by').notNull(),
    atGateAt: tstz('at_gate_at'),
    /** Business time (the weighment's offset-corrected capture time), like `dispatched_at`. */
    tareAt: tstz('tare_at'),
    /** Device that recorded the current tare: it may correct it; another device conflicts. */
    tareDeviceId: text('tare_device_id'),
    weighedAt: tstz('weighed_at'),
    /** The approval (TON-57): the dispatch. */
    dispatchedAt: tstz('dispatched_at'),
    cancelledAt: tstz('cancelled_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('trucks_tenant_id_id_key').on(t.tenantId, t.id),
    index('trucks_tenant_sub_order_state_idx').on(t.tenantId, t.subOrderId, t.state),
    index('trucks_tenant_transporter_idx').on(t.tenantId, t.transporterId),
    index('trucks_tenant_plant_idx').on(t.tenantId, t.plantId),
    uniqueIndex('trucks_tenant_loading_slip_key')
      .on(t.tenantId, t.loadingSlipNo)
      .where(sql`${t.loadingSlipNo} is not null`),
    check(
      'trucks_state_check',
      sql`${t.state} in ('assigned', 'at_gate', 'loading', 'weighed', 'dispatched', 'cancelled')`,
    ),
    // The truck's order is its sub-order's order. Never cascades: trucks are removed explicitly
    // (hard delete, B3's tombstones), never as a side effect.
    foreignKey({
      name: 'trucks_sub_order_fk',
      columns: [t.tenantId, t.orderId, t.subOrderId],
      foreignColumns: [subOrders.tenantId, subOrders.orderId, subOrders.id],
    }),
    foreignKey({
      name: 'trucks_plant_fk',
      columns: [t.tenantId, t.plantId],
      foreignColumns: [plants.tenantId, plants.id],
    }),
    foreignKey({
      name: 'trucks_transporter_fk',
      columns: [t.tenantId, t.transporterId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'trucks_assigned_by_fk',
      columns: [t.tenantId, t.assignedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'trucks_cancelled_by_fk',
      columns: [t.tenantId, t.cancelledBy],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/** What a truck is planned to load, per order line, in the order planned (`position`). */
export const truckPlanLines = pgTable(
  'truck_plan_lines',
  {
    tenantId: tenantId().references(() => tenants.id),
    truckId: uuid('truck_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    position: integer('position').notNull(),
    plannedKg: int8('planned_kg').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'truck_plan_lines_pkey', columns: [t.tenantId, t.truckId, t.orderLineId] }),
    index('truck_plan_lines_line_idx').on(t.tenantId, t.orderLineId),
    check('truck_plan_lines_planned_kg_check', sql`${t.plannedKg} >= 0`),
    foreignKey({
      name: 'truck_plan_lines_truck_fk',
      columns: [t.tenantId, t.truckId],
      foreignColumns: [trucks.tenantId, trucks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'truck_plan_lines_line_fk',
      columns: [t.tenantId, t.orderLineId],
      foreignColumns: [orderLines.tenantId, orderLines.id],
    }),
  ],
);

/** Net per line, set at dispatch; sums exactly to gross − tare. */
export const truckAllocations = pgTable(
  'truck_allocations',
  {
    tenantId: tenantId().references(() => tenants.id),
    truckId: uuid('truck_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    position: integer('position').notNull(),
    netKg: int8('net_kg').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'truck_allocations_pkey', columns: [t.tenantId, t.truckId, t.orderLineId] }),
    index('truck_allocations_line_idx').on(t.tenantId, t.orderLineId),
    check('truck_allocations_net_kg_check', sql`${t.netKg} >= 0`),
    foreignKey({
      name: 'truck_allocations_truck_fk',
      columns: [t.tenantId, t.truckId],
      foreignColumns: [trucks.tenantId, trucks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'truck_allocations_line_fk',
      columns: [t.tenantId, t.orderLineId],
      foreignColumns: [orderLines.tenantId, orderLines.id],
    }),
  ],
);
