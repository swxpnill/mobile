import type { PlantScope, PlantSupervisor } from '@tonnage/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import { brokerLedger, parties, plants, trucks, userPlants, users, weighments } from '../../db/schema/index.ts';
import type { AuthedUser } from '../../http/auth-hook.ts';
import { AppError } from '../../http/errors.ts';
import { graphMath, type GraphMath, type OrderGraph, type TruckRow } from '../../views/orderGraph.ts';
import type { TruckPlace, TruckViewCtx, WeighmentRow } from '../../views/trucks.ts';
import { anyId, loadOrderGraph, orderViewCtx } from '../orderGraph.ts';
import { isId } from '../org.ts';

const inPlantScope = (scope: PlantScope, plantId: string) => scope.kind === 'all' || scope.plantIds.includes(plantId);

/**
 * Everything the truck views need for `truckIds` (B3 Ruling 8): their orders' graphs (every truck of
 * those orders, for the line maths), the order view context, and the truck extras (plants,
 * supervisors, transporters, weighments, ledger sums). A bounded number of queries for any number of trucks.
 */
export async function truckViewCtx(
  tx: Tx,
  user: AuthedUser,
  scope: PlantScope,
  now: number,
  truckIds: readonly string[],
  opts: { supervisors?: boolean; weighments?: boolean } = {},
): Promise<TruckViewCtx> {
  const wanted = [...new Set(truckIds.filter(isId))];
  const orderRows =
    wanted.length === 0
      ? []
      : await tx.selectDistinct({ orderId: trucks.orderId }).from(trucks).where(anyId(trucks.id, wanted));
  const graphs = await loadOrderGraph(
    tx,
    orderRows.map((r) => r.orderId),
  );
  const base = await orderViewCtx(tx, user, scope, now, graphs.values());

  const wantedSet = new Set(wanted);
  const places = new Map<string, TruckPlace>();
  const maths = new Map<string, GraphMath>();
  const mathOf = (g: OrderGraph) => {
    let m = maths.get(g.order.id);
    if (!m) {
      m = graphMath(g);
      maths.set(g.order.id, m);
    }
    return m;
  };
  for (const graph of graphs.values()) {
    for (const sub of graph.subOrders) {
      for (const truck of sub.trucks) {
        if (wantedSet.has(truck.truck.id)) places.set(truck.truck.id, { graph, sub, truck, math: mathOf(graph) });
      }
    }
  }
  const chosen = [...places.values()].map((p) => p.truck.truck);
  const plantIds = [...new Set(chosen.map((t) => t.plantId))];
  const transporterIds = [...new Set(chosen.flatMap((t) => (t.transporterId ? [t.transporterId] : [])))];

  const plantRows = plantIds.length === 0 ? [] : await tx.select({ id: plants.id, name: plants.name }).from(plants).where(anyId(plants.id, plantIds));
  const transporterRows =
    transporterIds.length === 0
      ? []
      : await tx.select({ id: parties.id, name: parties.name }).from(parties).where(anyId(parties.id, transporterIds));
  const weighmentRows: WeighmentRow[] =
    opts.weighments && places.size > 0
      ? await tx
          .select()
          .from(weighments)
          .where(anyId(weighments.truckId, [...places.keys()]))
          .orderBy(asc(weighments.createdAt), asc(weighments.id))
      : [];
  const ledgerRows =
    places.size === 0
      ? []
      : await tx
          .select({ truckId: brokerLedger.truckId, sum: sql<string>`sum(${brokerLedger.amountRupees})` })
          .from(brokerLedger)
          .where(anyId(brokerLedger.truckId, [...places.keys()]))
          .groupBy(brokerLedger.truckId);

  const supervisorsByPlant = new Map<string, PlantSupervisor[]>();
  if (opts.supervisors && plantIds.length > 0) {
    const rows = await tx
      .select({ id: users.id, name: users.name, mobile: users.mobile, lastSeenAt: users.lastSeenAt, plantId: userPlants.plantId })
      .from(users)
      .innerJoin(userPlants, and(eq(userPlants.tenantId, users.tenantId), eq(userPlants.userId, users.id)))
      .where(and(eq(users.role, 'supervisor'), eq(users.active, true), inArray(userPlants.plantId, plantIds)));
    for (const plantId of plantIds) {
      supervisorsByPlant.set(
        plantId,
        rows
          .filter((r) => r.plantId === plantId)
          .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
          .map((r) => ({ id: r.id, name: r.name, mobile: r.mobile, invited: r.lastSeenAt === null })),
      );
    }
  }

  // People the trucks name (assigned by, weighed by) besides those the order view loaded.
  const userNameById = new Map(base.userNameById);
  const missing = [...new Set([...chosen.map((t) => t.assignedBy), ...weighmentRows.map((w) => w.enteredBy)])].filter(
    (id) => !userNameById.has(id),
  );
  if (missing.length > 0) {
    for (const u of await tx.select({ id: users.id, name: users.name }).from(users).where(anyId(users.id, missing))) {
      userNameById.set(u.id, u.name);
    }
  }

  const weighmentsByTruck = new Map<string, WeighmentRow[]>();
  for (const w of weighmentRows) weighmentsByTruck.set(w.truckId, [...(weighmentsByTruck.get(w.truckId) ?? []), w]);

  return {
    ...base,
    userNameById,
    places,
    plantNameById: new Map(plantRows.map((p) => [p.id, p.name])),
    supervisorsByPlant,
    transporterById: new Map(transporterRows.map((p) => [p.id, p])),
    weighmentsByTruck,
    earningByTruck: new Map(ledgerRows.flatMap((r) => (r.truckId ? [[r.truckId, Number(r.sum)] as const] : []))),
  };
}

/**
 * The truck by id in the caller's tenant and plant scope; 404 otherwise (the same for missing and
 * out of scope). `assertVisible` then checks its sub-order's company, as the mock's `findTruck`.
 */
export async function findTruckRow(tx: Tx, scope: PlantScope, id: string | undefined): Promise<TruckRow> {
  if (!isId(id)) throw new AppError(404, 'NOT_FOUND');
  const [row] = await tx.select().from(trucks).where(eq(trucks.id, id));
  if (!row || !inPlantScope(scope, row.plantId)) throw new AppError(404, 'NOT_FOUND');
  return row;
}

/** 404 unless the truck was loaded and its sub-order's company is one the caller may see. */
export function assertVisible(c: TruckViewCtx, truckId: string): void {
  const place = c.places.get(truckId);
  if (!place || !c.visibleCompanyIds.has(place.sub.sub.companyId)) throw new AppError(404, 'NOT_FOUND');
}

export { inPlantScope };
