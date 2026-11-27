import {
  type AssignTruckBody,
  type CancelTruckBody,
  type EditTruckBody,
  type Truck,
  assignable,
  isTerminal,
  nextTruckState,
} from '@tonnage/shared';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../../db/client.ts';
import { companies, parties, plants, truckPlanLines, trucks } from '../../db/schema/index.ts';
import { AppError } from '../../http/errors.ts';
import { graphMath, type OrderGraph, type SubOrderGraph, type TruckRow } from '../../views/orderGraph.ts';
import { toTruck, vehicleKey } from '../../views/trucks.ts';
import { logActivity } from '../activity.ts';
import { bumpChangeClock } from '../changeClock.ts';
import { afterTruckAssigned, afterTruckChanged } from '../dispatchEffects.ts';
import type { OrderWriteCtx } from '../orderEdit.ts';
import { lockSubOrder } from '../orderLifecycle.ts';
import { lockOrderTree } from '../orderTree.ts';
import { approveDispatch } from './apply.ts';
import { assertVisible, findTruckRow, inPlantScope, truckViewCtx } from './truckViews.ts';

// Ported from packages/mock-api/src/handlers/trucks.ts (assign, edit, cancel): the same checks, codes
// and activity. Lock order: order → sub-orders → lines → trucks (B2), then the change clock (B3).

export type Warning = NonNullable<Truck['warnings']>[number];

const withWarnings = (truck: Truck, warnings: Warning[]): Truck => (warnings.length > 0 ? { ...truck, warnings } : truck);
const blankToNull = (v: string | null): string | null => (v === null || v === '' ? null : v);
const validation = (path: (string | number)[], message: string) => new AppError(422, 'VALIDATION', [{ path, message }]);

/** Another open truck of the tenant with the same vehicle number. */
async function vehicleBusy(tx: Tx, vehicleNo: string, exceptId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: trucks.id, vehicleNo: trucks.vehicleNo })
    .from(trucks)
    .where(sql`${trucks.state} in ('assigned', 'at_gate', 'loading', 'weighed')`);
  const key = vehicleKey(vehicleNo);
  return rows.some((t) => t.id !== exceptId && vehicleKey(t.vehicleNo) === key);
}

async function checkTransporter(tx: Tx, id: string | null | undefined): Promise<void> {
  if (id === null || id === undefined) return;
  const [p] = await tx.select({ type: parties.type, active: parties.active }).from(parties).where(eq(parties.id, id));
  if (!p || p.type !== 'transporter' || !p.active) throw validation(['transporterId'], 'Choose an active transporter');
}

/** Each plan row's line must be on this sub-order; the first stranger is reported. */
function assertPlanLines(sub: SubOrderGraph, plan: { orderLineId: string }[]): void {
  const lineIds = new Set(sub.lines.map((l) => l.id));
  const stranger = plan.find((p) => !lineIds.has(p.orderLineId));
  if (stranger) throw new AppError(409, 'LINE_NOT_ON_ORDER', { lineId: stranger.orderLineId });
}

/** A plan row bigger than what is left to assign (the truck's own current plan is given back on edit). */
function overAssignable(
  g: OrderGraph,
  sub: SubOrderGraph,
  plan: { orderLineId: string; plannedKg: number }[],
  own?: { orderLineId: string; plannedKg: number }[],
): boolean {
  const math = graphMath(g);
  const lines = new Map(sub.lines.map((l) => [l.id, l]));
  return plan.some((p) => {
    const line = lines.get(p.orderLineId);
    if (!line) return false;
    const back = own?.find((x) => x.orderLineId === p.orderLineId)?.plannedKg ?? 0;
    return p.plannedKg > assignable(math.lineQty(line)) + back;
  });
}

async function truckResponse(tx: Tx, c: OrderWriteCtx, truckId: string, warnings: Warning[] = []): Promise<Truck> {
  const v = await truckViewCtx(tx, c.user, c.scope, c.now, [truckId], { supervisors: true, weighments: true });
  return withWarnings(toTruck(v, truckId, { withWeighments: true }), warnings);
}

const replacePlan = async (tx: Tx, t: { id: string; tenantId: string }, plan: { orderLineId: string; plannedKg: number }[], at: Date) => {
  await tx.delete(truckPlanLines).where(eq(truckPlanLines.truckId, t.id));
  if (plan.length > 0) {
    await tx.insert(truckPlanLines).values(
      plan.map((p, position) => ({ tenantId: t.tenantId, truckId: t.id, orderLineId: p.orderLineId, position, plannedKg: p.plannedKg, createdAt: at, updatedAt: at })),
    );
  }
};

/** `POST /v1/sub-orders/:id/trucks`. */
export async function assignTruck(tx: Tx, c: OrderWriteCtx, subOrderId: string | undefined, body: AssignTruckBody): Promise<Truck> {
  const { g, s } = await lockSubOrder(tx, c, subOrderId);
  if (isTerminal(graphMath(g).subOrderStatus(s))) throw new AppError(409, 'ORDER_LOCKED');
  if (g.order.customerId === null) throw new AppError(409, 'CUSTOMER_REQUIRED');
  const [company] = await tx.select({ active: companies.active }).from(companies).where(eq(companies.id, s.sub.companyId));
  if (!company?.active) throw new AppError(409, 'COMPANY_INACTIVE');

  const companyPlants = await tx
    .select({ id: plants.id, active: plants.active })
    .from(plants)
    .where(eq(plants.companyId, s.sub.companyId))
    .orderBy(plants.createdAt, plants.id);
  let plant = body.plantId !== undefined ? companyPlants.find((p) => p.id === body.plantId) : undefined;
  if (body.plantId !== undefined && !plant) throw validation(['plantId'], "Choose one of this company's plants");
  if (!plant) {
    const active = companyPlants.filter((p) => p.active);
    plant = companyPlants.length === 1 ? companyPlants[0] : active.length === 1 ? active[0] : undefined;
  }
  if (!plant) throw new AppError(422, 'PLANT_REQUIRED');
  if (!plant.active) throw new AppError(409, 'PLANT_INACTIVE');
  if (!inPlantScope(c.scope, plant.id)) throw new AppError(404, 'NOT_FOUND');
  await checkTransporter(tx, body.transporterId);
  assertPlanLines(s, body.plan);

  const warnings: Warning[] = [];
  if (await vehicleBusy(tx, body.vehicleNo)) warnings.push('VEHICLE_BUSY');
  if (overAssignable(g, s, body.plan)) warnings.push('OVER_ASSIGNABLE');

  const now = new Date(c.now);
  const changedAt = new Date(await bumpChangeClock(tx, c.user.tenantId, c.now));
  const id = uuidv7();
  await tx.insert(trucks).values({
    id,
    tenantId: c.user.tenantId,
    orderId: g.order.id,
    subOrderId: s.sub.id,
    plantId: plant.id,
    vehicleNo: body.vehicleNo,
    transporterId: body.transporterId,
    driverName: body.driverName,
    driverPhone: body.driverPhone,
    lrNo: blankToNull(body.lrNo),
    state: 'assigned',
    tareKg: null,
    grossKg: null,
    loadingSlipNo: null,
    assignedAt: now,
    assignedBy: c.user.id,
    version: 1,
    createdAt: now,
    updatedAt: changedAt,
  });
  await replacePlan(tx, { id, tenantId: c.user.tenantId }, body.plan, now);
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: g.order.id,
    orderId: g.order.id,
    action: 'truck.assigned',
    meta: { subOrderId: s.sub.id, truckId: id, vehicleNo: body.vehicleNo },
  });
  await afterTruckAssigned(tx, c, id);
  return truckResponse(tx, c, id, warnings);
}

/** The truck, in scope and visible, with its order tree locked (trucks too) and re-read under the lock. */
export async function lockTruck(tx: Tx, c: OrderWriteCtx, truckId: string | undefined): Promise<{ t: TruckRow; g: OrderGraph; s: SubOrderGraph }> {
  const head = await findTruckRow(tx, c.scope, truckId);
  assertVisible(await truckViewCtx(tx, c.user, c.scope, c.now, [head.id]), head.id);
  const g = await lockOrderTree(tx, head.orderId, { mode: 'no key update', subOrderId: head.subOrderId, trucks: true });
  const s = g?.subOrders.find((x) => x.sub.id === head.subOrderId);
  const t = s?.trucks.find((x) => x.truck.id === head.id)?.truck;
  if (!g || !s || !t) throw new AppError(404, 'NOT_FOUND');
  return { t, g, s };
}

/** `PATCH /v1/trucks/:id`. */
export async function editTruck(tx: Tx, c: OrderWriteCtx, truckId: string | undefined, body: EditTruckBody): Promise<Truck> {
  const { t, g, s } = await lockTruck(tx, c, truckId);
  if (body.version !== t.version) throw new AppError(409, 'STALE');
  const given = Object.entries(body)
    .filter(([k, v]) => k !== 'version' && v !== undefined)
    .map(([k]) => k);
  if (t.state === 'cancelled') throw new AppError(409, 'TRUCK_LOCKED');
  if (t.state === 'dispatched' && given.some((k) => k !== 'lrNo')) throw new AppError(409, 'TRUCK_LOCKED');
  // TON-57: weighed, awaiting approval: the load is on the truck; its plan is history now.
  if (t.state === 'weighed' && body.plan !== undefined) throw new AppError(409, 'TRUCK_LOCKED');

  if (body.transporterId !== undefined) await checkTransporter(tx, body.transporterId);
  if (body.plan !== undefined) assertPlanLines(s, body.plan);
  const own = s.trucks.find((x) => x.truck.id === t.id)?.plan.map((p) => ({ orderLineId: p.orderLineId, plannedKg: p.plannedKg }));
  const warnings: Warning[] = [];
  const vehicleNo = body.vehicleNo ?? t.vehicleNo;
  if (body.vehicleNo !== undefined && (await vehicleBusy(tx, vehicleNo, t.id))) warnings.push('VEHICLE_BUSY');
  if (body.plan !== undefined && overAssignable(g, s, body.plan, own)) warnings.push('OVER_ASSIGNABLE');

  const changedAt = new Date(await bumpChangeClock(tx, c.user.tenantId, c.now));
  await tx
    .update(trucks)
    .set({
      vehicleNo,
      ...(body.transporterId !== undefined ? { transporterId: body.transporterId } : {}),
      ...(body.driverName !== undefined ? { driverName: body.driverName } : {}),
      ...(body.driverPhone !== undefined ? { driverPhone: body.driverPhone } : {}),
      ...(body.lrNo !== undefined ? { lrNo: blankToNull(body.lrNo) } : {}),
      version: t.version + 1,
      updatedAt: changedAt,
    })
    .where(and(eq(trucks.id, t.id), eq(trucks.version, t.version)));
  if (body.plan !== undefined) await replacePlan(tx, t, body.plan, new Date(c.now));
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: t.orderId,
    orderId: t.orderId,
    action: 'truck.edited',
    meta: { subOrderId: t.subOrderId, truckId: t.id, vehicleNo, fields: given },
  });
  await afterTruckChanged(tx, c, t.id);
  return truckResponse(tx, c, t.id, warnings);
}

/** `POST /v1/trucks/:id/cancel`. */
export async function cancelTruck(tx: Tx, c: OrderWriteCtx, truckId: string | undefined, body: CancelTruckBody): Promise<Truck> {
  const { t } = await lockTruck(tx, c, truckId);
  if (body.version !== t.version) throw new AppError(409, 'STALE');
  const next = nextTruckState(t.state, 'cancel');
  if (next === null) throw new AppError(409, 'TRUCK_LOCKED');
  const note = body.note.trim();
  const now = new Date(c.now);
  const changedAt = new Date(await bumpChangeClock(tx, c.user.tenantId, c.now));
  await tx
    .update(trucks)
    .set({
      state: next,
      cancelledAt: now,
      cancelledBy: c.user.id,
      cancelReason: note === '' ? body.reason : `${body.reason} — ${note}`,
      version: t.version + 1,
      updatedAt: changedAt,
    })
    .where(eq(trucks.id, t.id));
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: t.orderId,
    orderId: t.orderId,
    action: 'truck.cancelled',
    meta: { subOrderId: t.subOrderId, truckId: t.id, vehicleNo: t.vehicleNo, reason: body.reason },
  });
  await afterTruckChanged(tx, c, t.id);
  return truckResponse(tx, c, t.id);
}

/** `POST /v1/trucks/:id/approve` (TON-57): the office approves a weighed truck; that is the dispatch. */
export async function approveTruck(tx: Tx, c: OrderWriteCtx, truckId: string | undefined, version: number): Promise<Truck> {
  const { t } = await lockTruck(tx, c, truckId);
  if (nextTruckState(t.state, 'approve') === null) throw new AppError(409, 'NOT_AWAITING_APPROVAL');
  if (version !== t.version) throw new AppError(409, 'STALE');
  await approveDispatch(tx, c, t);
  return truckResponse(tx, c, t.id);
}
