import { productDisplayName, type PlantScope } from '@tonnage/shared';
import { asc, sql, type SQLWrapper } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import {
  orderLines,
  orders,
  parties,
  partyAddresses,
  products,
  subOrders,
  truckAllocations,
  truckPlanLines,
  trucks,
  users,
} from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { AppError } from '../http/errors.ts';
import type { OrderGraph, SubOrderGraph, TruckGraph } from '../views/orderGraph.ts';
import { type OrderViewCtx, visibleSubOrders } from '../views/orders.ts';
import { isId, visibleCompanies } from './org.ts';
import { loadSettings } from './settings.ts';

/**
 * `column = any($1::uuid[])`: one array parameter whatever the number of ids (an `in (...)` list
 * would bind one parameter per id and hit the protocol's limit on a long list).
 */
export const anyId = (column: SQLWrapper, ids: readonly string[]) =>
  sql`${column} = any(${sql.param([...ids])}::uuid[])`;

const groupBy = <T, K>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const list = out.get(key(r));
    if (list) list.push(r);
    else out.set(key(r), [r]);
  }
  return out;
};

/**
 * Orders with their sub-orders, lines, trucks, plans and allocations: at most six sequential
 * queries for any number of orders (Ruling 4), one per table, skipping the rest once one comes
 * back empty. Row-level security keeps every query to the caller's tenant; ids that are not the
 * tenant's (or not uuids) are absent. The map follows the order of `orderIds`.
 *
 * Orderings mirror the mock's arrays: sub-orders by suffix (A … Z, AA …, the order companies were
 * added), lines by `position` (creation order), trucks by id (uuid v7: creation order), plan and
 * allocation rows by `position`.
 */
export async function loadOrderGraph(tx: Tx, orderIds: readonly string[]): Promise<Map<string, OrderGraph>> {
  const wanted = [...new Set(orderIds.filter(isId))];
  const out = new Map<string, OrderGraph>();
  if (wanted.length === 0) return out;
  // One after another: a transaction is one connection, and pg queues (and deprecates) overlapping queries.
  const orderRows = await tx.select().from(orders).where(anyId(orders.id, wanted));
  if (orderRows.length === 0) return out;
  const subRows = await tx
    .select()
    .from(subOrders)
    .where(anyId(subOrders.orderId, orderRows.map((o) => o.id)))
    .orderBy(asc(subOrders.orderId), sql`length(${subOrders.suffix})`, asc(subOrders.suffix));
  const subIds = subRows.map((s) => s.id);
  const lineRows =
    subIds.length === 0
      ? []
      : await tx
          .select()
          .from(orderLines)
          .where(anyId(orderLines.subOrderId, subIds))
          .orderBy(asc(orderLines.subOrderId), asc(orderLines.position));
  const truckRows =
    subIds.length === 0
      ? []
      : await tx.select().from(trucks).where(anyId(trucks.subOrderId, subIds)).orderBy(asc(trucks.id));
  const truckIds = truckRows.map((t) => t.id);
  const planRows =
    truckIds.length === 0
      ? []
      : await tx
          .select()
          .from(truckPlanLines)
          .where(anyId(truckPlanLines.truckId, truckIds))
          .orderBy(asc(truckPlanLines.truckId), asc(truckPlanLines.position));
  const allocationRows =
    truckIds.length === 0
      ? []
      : await tx
          .select()
          .from(truckAllocations)
          .where(anyId(truckAllocations.truckId, truckIds))
          .orderBy(asc(truckAllocations.truckId), asc(truckAllocations.position));

  const planByTruck = groupBy(planRows, (p) => p.truckId);
  const allocationsByTruck = groupBy(allocationRows, (a) => a.truckId);
  const trucksBySub = groupBy(
    truckRows.map(
      (truck): TruckGraph => ({
        truck,
        plan: planByTruck.get(truck.id) ?? [],
        allocations: allocationsByTruck.get(truck.id) ?? [],
      }),
    ),
    (t) => t.truck.subOrderId,
  );
  const linesBySub = groupBy(lineRows, (l) => l.subOrderId);
  const subsByOrder = groupBy(
    subRows.map(
      (sub): SubOrderGraph => ({ sub, lines: linesBySub.get(sub.id) ?? [], trucks: trucksBySub.get(sub.id) ?? [] }),
    ),
    (s) => s.sub.orderId,
  );
  const byId = new Map(orderRows.map((o) => [o.id, o]));
  for (const id of wanted) {
    const order = byId.get(id);
    if (order) out.set(id, { order, subOrders: subsByOrder.get(id) ?? [] });
  }
  return out;
}

/**
 * The view context for these graphs: the tenant's settings, the caller's visible companies, and the
 * names the responses show (products, parties, addresses, people), each loaded once for all graphs.
 */
export async function orderViewCtx(
  tx: Tx,
  user: AuthedUser,
  scope: PlantScope,
  now: number,
  graphs: Iterable<OrderGraph>,
): Promise<OrderViewCtx> {
  const productIds = new Set<string>();
  const partyIds = new Set<string>();
  const addressIds = new Set<string>();
  const userIds = new Set<string>();
  const add = (set: Set<string>, id: string | null) => {
    if (id !== null) set.add(id);
  };
  for (const g of graphs) {
    const o = g.order;
    add(partyIds, o.customerId);
    add(partyIds, o.brokerId);
    add(addressIds, o.billToId);
    add(addressIds, o.shipToId);
    add(userIds, o.createdBy);
    for (const s of g.subOrders) {
      add(userIds, s.sub.closedBy);
      for (const l of s.lines) productIds.add(l.productId);
    }
  }
  const settings = await loadSettings(tx, user.tenantId);
  const companies = await visibleCompanies(tx, scope);
  const productRows =
    productIds.size === 0
      ? []
      : await tx
          .select({ id: products.id, category: products.category, grade: products.grade, sizeLabel: products.sizeLabel })
          .from(products)
          .where(anyId(products.id, [...productIds]));
  const partyRows =
    partyIds.size === 0
      ? []
      : await tx
          .select({ id: parties.id, name: parties.name, city: parties.city })
          .from(parties)
          .where(anyId(parties.id, [...partyIds]));
  const addressRows =
    addressIds.size === 0
      ? []
      : await tx
          .select({
            id: partyAddresses.id,
            partyId: partyAddresses.partyId,
            label: partyAddresses.label,
            address: partyAddresses.address,
          })
          .from(partyAddresses)
          .where(anyId(partyAddresses.id, [...addressIds]));
  const userRows =
    userIds.size === 0
      ? []
      : await tx.select({ id: users.id, name: users.name }).from(users).where(anyId(users.id, [...userIds]));
  return {
    now,
    settings,
    visibleCompanyIds: new Set(companies.map((c) => c.id)),
    companyById: new Map(companies.map((c) => [c.id, { code: c.code, name: c.name }])),
    productById: new Map(
      productRows.map((p) => [p.id, { name: productDisplayName(p), category: p.category, sizeLabel: p.sizeLabel }]),
    ),
    partyById: new Map(partyRows.map((p) => [p.id, p])),
    addressById: new Map(addressRows.map((a) => [a.id, a])),
    userNameById: new Map(userRows.map((u) => [u.id, u.name])),
  };
}

/** The order with its view context, or 404 when it is missing or none of its sub-orders is visible. */
export async function findOrder(
  tx: Tx,
  user: AuthedUser,
  scope: PlantScope,
  now: number,
  id: string | undefined,
): Promise<{ graph: OrderGraph; ctx: OrderViewCtx }> {
  const graph = isId(id) ? (await loadOrderGraph(tx, [id])).get(id) : undefined;
  if (!graph) throw new AppError(404, 'NOT_FOUND');
  const ctx = await orderViewCtx(tx, user, scope, now, [graph]);
  if (visibleSubOrders(ctx, graph).length === 0) throw new AppError(404, 'NOT_FOUND');
  return { graph, ctx };
}
