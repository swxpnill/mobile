import {
  CLOCK_SKEW_FLAG_MS,
  ERROR_MESSAGES,
  type PlantScope,
  type SyncEvent,
  type SyncRejectCode,
  type SyncResult,
  checkAllocations,
  netKg,
  overToleranceKg,
  toleranceCloseKg,
} from '@tonnage/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../../db/client.ts';
import { orderLines, subOrders, truckAllocations, trucks, users, weighments } from '../../db/schema/index.ts';
import type { AuthedUser } from '../../http/auth-hook.ts';
import { graphMath, type TruckRow } from '../../views/orderGraph.ts';
import { toTask } from '../../views/trucks.ts';
import { logActivity } from '../activity.ts';
import { bumpChangeClock } from '../changeClock.ts';
import { afterArrived, afterDispatched, afterOverTolerance, afterWeighed } from '../dispatchEffects.ts';
import type { OrderWriteCtx } from '../orderEdit.ts';
import { loadOrderGraph } from '../orderGraph.ts';
import { bumped, lockOrderTree } from '../orderTree.ts';
import { loadSettings } from '../settings.ts';
import { issueLoadingSlip, writeEarning } from './money.ts';
import { inPlantScope, truckViewCtx } from './truckViews.ts';

// Ported from packages/mock-api/src/dispatch.ts: the §6.5 table for one sync event, the approval
// (the dispatch, TON-57) and the tolerance close. Each runs inside the caller's transaction.

export interface DispatchCtx {
  user: AuthedUser;
  scope: PlantScope;
  deviceId: string;
  /** Server time the event is received. */
  now: number;
  /** Device clock offset (server − device), added to `capturedAtDevice` for business time. */
  offsetMs: number;
}

type Rejected = Extract<SyncResult, { status: 'rejected' }>;

export const reject = (eventId: string, code: SyncRejectCode, server?: Rejected['server']): Rejected =>
  server
    ? { status: 'rejected', eventId, code, message: ERROR_MESSAGES[code], server }
    : { status: 'rejected', eventId, code, message: ERROR_MESSAGES[code] };

const writeCtx = (ctx: DispatchCtx): OrderWriteCtx => ({ user: ctx.user, scope: ctx.scope, now: ctx.now });

/** The truck's live (not superseded) weighment of a kind, if any. */
export async function currentWeighment(tx: Tx, truckId: string, kind: 'tare' | 'gross') {
  const [w] = await tx
    .select()
    .from(weighments)
    .where(and(eq(weighments.truckId, truckId), eq(weighments.kind, kind), isNull(weighments.supersededBy)))
    .orderBy(desc(weighments.createdAt), desc(weighments.id))
    .limit(1);
  return w;
}

/** The truck, in the caller's tenant and plant scope, locked with its order tree; undefined otherwise. */
async function lockedTruck(tx: Tx, scope: PlantScope, truckId: string): Promise<TruckRow | undefined> {
  const [head] = await tx.select().from(trucks).where(eq(trucks.id, truckId));
  if (!head || !inPlantScope(scope, head.plantId)) return undefined;
  const g = await lockOrderTree(tx, head.orderId, { mode: 'no key update', subOrderId: head.subOrderId, trucks: true });
  return g?.subOrders.flatMap((s) => s.trucks).find((x) => x.truck.id === head.id)?.truck;
}

/** Decides one event (§6.5, first match wins). Business refusals come back as `rejected`, never thrown. */
export async function decideEvent(tx: Tx, ctx: DispatchCtx, event: SyncEvent): Promise<SyncResult> {
  const id = event.eventId;
  const truck = await lockedTruck(tx, ctx.scope, event.truckId);
  if (!truck) return reject(id, 'PLANT_SCOPE');
  const atState = (): Rejected['server'] => ({ state: truck.state });
  // Past the phone's part: weighed (awaiting the office), dispatched or cancelled.
  const done = truck.state === 'cancelled' || truck.state === 'dispatched' || truck.state === 'weighed';
  // An arrival may reach the server late: on a truck past it, it is a no-op, not a refusal.
  if (event.type === 'AT_GATE' && done) return { status: 'accepted', eventId: id, task: null };
  if (truck.state === 'cancelled') return reject(id, 'TRUCK_CANCELLED', atState());
  if (truck.state === 'dispatched') return reject(id, 'ALREADY_DISPATCHED', atState());
  // TON-57: the weights are with the office; it changes them, the phone no longer can.
  if (truck.state === 'weighed') return reject(id, 'ALREADY_WEIGHED', atState());

  const capturedAt = new Date(Date.parse(event.capturedAtDevice) + ctx.offsetMs);
  const clockSkewFlag = Math.abs(ctx.offsetMs) > CLOCK_SKEW_FLAG_MS;
  const c = writeCtx(ctx);
  const log = (action: string, meta: Record<string, unknown> = {}) =>
    logActivity(tx, ctx.user, ctx.now, {
      entityType: 'order',
      entityId: truck.orderId,
      orderId: truck.orderId,
      action,
      meta: { subOrderId: truck.subOrderId, truckId: truck.id, vehicleNo: truck.vehicleNo, ...meta, ...(clockSkewFlag ? { clockSkew: true } : {}) },
    });
  const weigh = async (kind: 'tare' | 'gross', kg: number): Promise<string> => {
    const wid = uuidv7();
    const received = new Date(ctx.now);
    await tx.insert(weighments).values({
      id: wid,
      tenantId: truck.tenantId,
      truckId: truck.id,
      kind,
      kg,
      enteredBy: ctx.user.id,
      deviceId: ctx.deviceId,
      clientEventId: id,
      capturedAtDevice: new Date(event.capturedAtDevice),
      capturedAt,
      receivedAt: received,
      clockSkewFlag,
      supersededBy: null,
      createdAt: received,
      updatedAt: received,
    });
    return wid;
  };
  /** Writes the truck's new fields with a version bump at the change-clock time. */
  const save = async (fields: Partial<typeof trucks.$inferInsert>) => {
    const changedAt = new Date(await bumpChangeClock(tx, truck.tenantId, ctx.now));
    await tx
      .update(trucks)
      .set({ ...fields, version: bumped(trucks.version), updatedAt: changedAt })
      .where(eq(trucks.id, truck.id));
  };
  // A weighed truck has left the phone's tasks (the office approves it).
  const accepted = async (): Promise<SyncResult> => {
    const [now] = await tx.select({ state: trucks.state }).from(trucks).where(eq(trucks.id, truck.id));
    if (now?.state === 'weighed') return { status: 'accepted', eventId: id, task: null };
    const v = await truckViewCtx(tx, ctx.user, ctx.scope, ctx.now, [truck.id]);
    return { status: 'accepted', eventId: id, task: toTask(v, truck.id) };
  };

  switch (event.type) {
    case 'AT_GATE': {
      // "Vehicle arrived" (TON-57). A late or repeated one changes nothing once the truck is past it.
      if (truck.state !== 'assigned') return accepted();
      await save({ state: 'at_gate', atGateAt: capturedAt });
      await log('truck.at_gate');
      await afterArrived(tx, c, truck.id);
      return accepted();
    }

    case 'TARE': {
      if (truck.state === 'loading') {
        if (truck.tareDeviceId !== ctx.deviceId) {
          const current = await currentWeighment(tx, truck.id, 'tare');
          const [by] = current ? await tx.select({ name: users.name }).from(users).where(eq(users.id, current.enteredBy)) : [];
          return reject(id, 'TARE_CONFLICT', {
            ...(truck.tareKg !== null ? { tareKg: truck.tareKg } : {}),
            ...(by !== undefined ? { by: by.name } : {}),
            ...(truck.tareAt !== null ? { at: truck.tareAt.toISOString() } : {}),
            state: truck.state,
          });
        }
        // Same phone: the supervisor fixed a typo before the gross.
        const previous = await currentWeighment(tx, truck.id, 'tare');
        const wid = await weigh('tare', event.tareKg);
        if (previous) await tx.update(weighments).set({ supersededBy: wid }).where(eq(weighments.id, previous.id));
        await save({ tareKg: event.tareKg, tareAt: capturedAt, tareDeviceId: ctx.deviceId });
        await log('truck.tare_corrected', { tareKg: event.tareKg, previousTareKg: truck.tareKg });
        return accepted();
      }
      // TON-57: tare only after "Vehicle arrived".
      if (truck.state === 'assigned') return reject(id, 'ARRIVAL_REQUIRED', atState());
      await weigh('tare', event.tareKg);
      await save({ state: 'loading', tareKg: event.tareKg, tareAt: capturedAt, tareDeviceId: ctx.deviceId });
      await log('truck.tare', { tareKg: event.tareKg });
      return accepted();
    }

    case 'GROSS': {
      if (truck.tareKg === null) return reject(id, 'TARE_REQUIRED', atState());
      if (truck.state !== 'loading') return reject(id, 'INVALID_STATE', atState());
      const net = netKg(event.grossKg, truck.tareKg);
      const lineIds = new Set(
        (await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.subOrderId, truck.subOrderId))).map((l) => l.id),
      );
      const check = checkAllocations(net, event.allocations, lineIds);
      if (check !== 'ok') return reject(id, check, atState());

      // TON-57: the weights go to the office for approval; nothing is dispatched yet.
      await weigh('gross', event.grossKg);
      await replaceAllocations(tx, truck, event.allocations, ctx.now);
      await save({ state: 'weighed', grossKg: event.grossKg, weighedAt: capturedAt });
      await log('truck.weighed', { netKg: net });
      await afterWeighed(tx, c, truck.id, net);
      return accepted();
    }
  }
}

/** Replaces a truck's allocations, in the order given. */
export async function replaceAllocations(
  tx: Tx,
  truck: { id: string; tenantId: string },
  allocations: readonly { orderLineId: string; netKg: number }[],
  nowMs: number,
): Promise<void> {
  const at = new Date(nowMs);
  await tx.delete(truckAllocations).where(eq(truckAllocations.truckId, truck.id));
  if (allocations.length > 0) {
    await tx.insert(truckAllocations).values(
      allocations.map((a, position) => ({ tenantId: truck.tenantId, truckId: truck.id, orderLineId: a.orderLineId, position, netKg: a.netKg, createdAt: at, updatedAt: at })),
    );
  }
}

/**
 * TON-57: the office approves a weighed truck, and that is the dispatch (§5.2): dispatched at `now`,
 * the loading slip numbered then, the broker earning, then the sub-order's tolerance close. The
 * caller has locked the order tree and checked the state.
 */
export async function approveDispatch(tx: Tx, c: OrderWriteCtx, truck: TruckRow): Promise<void> {
  if (truck.state !== 'weighed' || truck.grossKg === null || truck.tareKg === null) {
    throw new Error(`truck ${truck.id} is not awaiting approval`);
  }
  const net = netKg(truck.grossKg, truck.tareKg);
  const slip = await issueLoadingSlip(tx, truck, c.now);
  const changedAt = new Date(await bumpChangeClock(tx, truck.tenantId, c.now));
  await tx
    .update(trucks)
    .set({ state: 'dispatched', dispatchedAt: new Date(c.now), loadingSlipNo: slip, version: bumped(trucks.version), updatedAt: changedAt })
    .where(eq(trucks.id, truck.id));
  await writeEarning(tx, truck, c.now, c.user.id);
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: truck.orderId,
    orderId: truck.orderId,
    action: 'truck.dispatched',
    meta: { subOrderId: truck.subOrderId, truckId: truck.id, vehicleNo: truck.vehicleNo, netKg: net, loadingSlipNo: slip },
  });
  await afterDispatched(tx, c, truck.id, net);
  await closeWithinTolerance(tx, c, truck);
}

/**
 * §5.1 tolerance in the dispatch transaction: when pending is within the tenant's tolerance and
 * nothing else is open on the sub-order, close the rest; flag a sub-order over by more than it.
 */
export async function closeWithinTolerance(tx: Tx, c: OrderWriteCtx, truck: Pick<TruckRow, 'orderId' | 'subOrderId'>): Promise<void> {
  const g = (await loadOrderGraph(tx, [truck.orderId])).get(truck.orderId);
  const sub = g?.subOrders.find((s) => s.sub.id === truck.subOrderId);
  if (!g || !sub) throw new Error(`no sub-order ${truck.subOrderId}`);
  const toleranceKg = (await loadSettings(tx, c.user.tenantId)).completionToleranceKg;
  const math = graphMath(g);
  const qtys = sub.lines.map(math.lineQty);
  const closeKg = sub.sub.closeKind === null ? toleranceCloseKg(qtys, toleranceKg, math.openTrucksOf(sub).length) : null;
  const at = new Date(c.now);
  if (closeKg) {
    for (const [i, l] of sub.lines.entries()) {
      const kg = closeKg[i] ?? 0;
      if (kg === 0) continue;
      await tx
        .update(orderLines)
        .set({ closedKg: l.closedKg + kg, version: bumped(orderLines.version), updatedAt: at })
        .where(eq(orderLines.id, l.id));
    }
    await tx
      .update(subOrders)
      .set({ closeKind: 'tolerance', closeReason: 'Within tolerance', closedAt: at, closedBy: c.user.id, version: bumped(subOrders.version), updatedAt: at })
      .where(eq(subOrders.id, sub.sub.id));
  }
  const overKg = overToleranceKg(qtys, toleranceKg);
  if (overKg > 0) {
    await logActivity(tx, c.user, c.now, {
      entityType: 'order',
      entityId: truck.orderId,
      orderId: truck.orderId,
      action: 'order.over_tolerance',
      meta: { subOrderId: sub.sub.id, kg: overKg },
    });
    await afterOverTolerance(tx, c, sub.sub.id, overKg);
  }
}

/**
 * Undoes a tolerance close of the truck's sub-order (a weight correction re-evaluates it): the
 * lines' closed kg go back to 0 and the sub-order is open again. Nothing for other close kinds.
 */
export async function undoToleranceClose(tx: Tx, nowMs: number, truck: Pick<TruckRow, 'subOrderId'>): Promise<void> {
  const [sub] = await tx.select().from(subOrders).where(eq(subOrders.id, truck.subOrderId));
  if (!sub || sub.closeKind !== 'tolerance') return;
  const at = new Date(nowMs);
  const lines = await tx.select().from(orderLines).where(eq(orderLines.subOrderId, sub.id));
  for (const l of lines) {
    if (l.closedKg === 0) continue;
    await tx.update(orderLines).set({ closedKg: 0, version: bumped(orderLines.version), updatedAt: at }).where(eq(orderLines.id, l.id));
  }
  await tx
    .update(subOrders)
    .set({ closeKind: null, closeReason: null, closeNote: null, closedAt: null, closedBy: null, version: bumped(subOrders.version), updatedAt: at })
    .where(eq(subOrders.id, sub.id));
}
