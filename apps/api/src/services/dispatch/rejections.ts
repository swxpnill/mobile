import {
  type Rejection,
  type RejectionCount,
  type RestoreRejectionResult,
  type SyncEvent,
  plantScope,
  subOrderNumber,
} from '@tonnage/shared';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import { orders, plants, subOrders, syncEvents, trucks, userPlants, users, weighmentRejections } from '../../db/schema/index.ts';
import type { AuthedUser } from '../../http/auth-hook.ts';
import { AppError } from '../../http/errors.ts';
import { logActivity } from '../activity.ts';
import { bumpChangeClock } from '../changeClock.ts';
import type { OrderWriteCtx } from '../orderEdit.ts';
import { anyId } from '../orderGraph.ts';
import { bumped } from '../orderTree.ts';
import { isId } from '../org.ts';
import { type DispatchCtx, currentWeighment, decideEvent } from './apply.ts';
import { type Warning, lockTruck, overAssignable, truckResponse, vehicleBusy } from './assign.ts';

// Ported from packages/mock-api/src/handlers/rejections.ts: Needs attention (§6.5). Owner only, so
// no plant scope applies to the list; a restore re-runs the event as its original sender.

type RejectionRow = typeof weighmentRejections.$inferSelect;

/** What the phone sent, kg fields only (no device clock, no ids but the lines'). */
function payloadOf(event: SyncEvent): Record<string, unknown> {
  switch (event.type) {
    case 'AT_GATE':
      return {};
    case 'TARE':
      return { tareKg: event.tareKg };
    case 'GROSS':
      return { grossKg: event.grossKg, allocations: event.allocations.map((x) => ({ ...x })) };
  }
}

/** The response rows, with truck, sub-order number, plant and people's names. */
async function toRejections(tx: Tx, rows: readonly RejectionRow[]): Promise<Rejection[]> {
  if (rows.length === 0) return [];
  const truckIds = [...new Set(rows.map((r) => r.truckId))];
  const places = await tx
    .select({ id: trucks.id, vehicleNo: trucks.vehicleNo, number: orders.number, suffix: subOrders.suffix, plantName: plants.name })
    .from(trucks)
    .innerJoin(subOrders, eq(subOrders.id, trucks.subOrderId))
    .innerJoin(orders, eq(orders.id, trucks.orderId))
    .innerJoin(plants, eq(plants.id, trucks.plantId))
    .where(anyId(trucks.id, truckIds));
  const placeById = new Map(places.map((p) => [p.id, p]));
  const userIds = [...new Set(rows.flatMap((r) => (r.resolvedBy === null ? [r.userId] : [r.userId, r.resolvedBy])))];
  const names = await tx.select({ id: users.id, name: users.name }).from(users).where(anyId(users.id, userIds));
  const nameById = new Map(names.map((u) => [u.id, u.name]));
  const ref = (id: string) => ({ id, name: nameById.get(id) ?? '' });
  return rows.map((r) => {
    const place = placeById.get(r.truckId);
    if (!place) throw new Error(`rejection ${r.id} has no truck`);
    return {
      id: r.id,
      truckId: r.truckId,
      vehicleNo: place.vehicleNo,
      subOrderNumber: subOrderNumber(place.number ?? '', place.suffix),
      plantName: place.plantName,
      user: ref(r.userId),
      eventType: r.event.type,
      payload: payloadOf(r.event),
      code: r.code,
      serverState: r.serverState,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedBy: r.resolvedBy === null ? null : ref(r.resolvedBy),
      resolutionNote: r.resolutionNote,
    };
  });
}

/** `GET /v1/weighment-rejections`: newest first; a sync's rows share a time, so the later event first. */
export async function listRejections(tx: Tx, status: 'open' | 'all'): Promise<Rejection[]> {
  const rows = await tx
    .select()
    .from(weighmentRejections)
    .where(status === 'all' ? undefined : eq(weighmentRejections.status, 'open'))
    .orderBy(desc(weighmentRejections.createdAt), desc(weighmentRejections.id));
  return toRejections(tx, rows);
}

/** `GET /v1/weighment-rejections/count`. */
export async function countRejections(tx: Tx): Promise<RejectionCount> {
  const [row] = await tx
    .select({ open: sql<number>`count(*)::int` })
    .from(weighmentRejections)
    .where(eq(weighmentRejections.status, 'open'));
  return { open: row?.open ?? 0 };
}

/** The rejection by id in the caller's tenant (RLS), locked; 404 otherwise. */
async function lockRejection(tx: Tx, id: string | undefined): Promise<RejectionRow> {
  if (!isId(id)) throw new AppError(404, 'NOT_FOUND');
  const [r] = await tx.select().from(weighmentRejections).where(eq(weighmentRejections.id, id)).for('update');
  if (!r) throw new AppError(404, 'NOT_FOUND');
  return r;
}

function assertOpen(r: RejectionRow): void {
  if (r.status !== 'open') throw new AppError(409, 'ALREADY_RESOLVED');
}

/** The sender of a stored event as they are now (a changed plant scope applies). */
async function senderOf(tx: Tx, r: RejectionRow): Promise<AuthedUser> {
  const [u] = await tx.select().from(users).where(eq(users.id, r.userId));
  if (!u) throw new Error(`rejection ${r.id} has no sender`);
  const plantRows = await tx.select({ plantId: userPlants.plantId }).from(userPlants).where(eq(userPlants.userId, u.id)).orderBy(asc(userPlants.plantId));
  return {
    id: u.id,
    tenantId: u.tenantId,
    tenantName: '',
    role: u.role,
    plantIds: plantRows.map((p) => p.plantId),
    name: u.name,
    mobile: u.mobile,
    preferences: { unitBasis: u.preferences.unitBasis },
  };
}

/**
 * `POST /v1/weighment-rejections/:id/restore`. A cancelled truck goes back where its weighments
 * leave it, then the event (and the same phone's later events of the truck, blocked behind it)
 * re-run through the sync code as their sender. Any refusal again is 409 with its code, and the
 * whole restore rolls back.
 */
export async function restoreRejection(tx: Tx, c: OrderWriteCtx, id: string | undefined): Promise<RestoreRejectionResult> {
  const first = await lockRejection(tx, id);
  assertOpen(first);
  const { t, g, s } = await lockTruck(tx, c, first.truckId);
  const chain = [
    first,
    ...(
      await tx
        .select()
        .from(weighmentRejections)
        .where(
          and(
            eq(weighmentRejections.status, 'open'),
            eq(weighmentRejections.truckId, first.truckId),
            eq(weighmentRejections.deviceId, first.deviceId),
            gt(sql`(${weighmentRejections.event} ->> 'deviceSeq')::bigint`, first.event.deviceSeq),
          ),
        )
        .for('update')
    ).sort((x, y) => x.event.deviceSeq - y.event.deviceSeq),
  ];

  const changedAt = new Date(await bumpChangeClock(tx, t.tenantId, c.now));
  // Back on the road: warn as an assign would, checked before the truck counts as open again.
  const warnings: Warning[] = [];
  if (t.state === 'cancelled') {
    if (await vehicleBusy(tx, t.vehicleNo, t.id)) warnings.push('VEHICLE_BUSY');
    const plan = s.trucks.find((x) => x.truck.id === t.id)?.plan ?? [];
    if (overAssignable(g, s, plan)) warnings.push('OVER_ASSIGNABLE');
    if (s.sub.closeKind === 'short_close' || s.sub.closeKind === 'cancel') throw new AppError(409, 'ORDER_LOCKED');
    const hasTare = t.tareKg !== null && (await currentWeighment(tx, t.id, 'tare')) !== undefined;
    const state = hasTare ? 'loading' : 'assigned';
    await tx
      .update(trucks)
      .set({ state, cancelledAt: null, cancelledBy: null, cancelReason: null, version: bumped(trucks.version), updatedAt: changedAt })
      .where(eq(trucks.id, t.id));
    await logActivity(tx, c.user, c.now, {
      entityType: 'order',
      entityId: t.orderId,
      orderId: t.orderId,
      action: 'truck.reinstated',
      meta: { subOrderId: t.subOrderId, truckId: t.id, vehicleNo: t.vehicleNo, state },
    });
  }

  for (const r of chain) {
    // Re-run as the original sender and phone, through the same dispatch code as a sync.
    await tx.delete(syncEvents).where(and(eq(syncEvents.tenantId, r.tenantId), eq(syncEvents.clientEventId, r.clientEventId)));
    const sender = await senderOf(tx, r);
    const d: DispatchCtx = { user: sender, scope: plantScope(sender), deviceId: r.deviceId, now: c.now, offsetMs: r.offsetMs };
    const [now] = await tx.select({ state: trucks.state }).from(trucks).where(eq(trucks.id, t.id));
    // TON-57: a tare sent before "Vehicle arrived" is restored as arrival then tare; the arrival takes
    // the tare's own business time. No "truck arrived" notification (Ruling 21).
    if (r.event.type === 'TARE' && now?.state === 'assigned') {
      const arrivedAt = new Date(Date.parse(r.event.capturedAtDevice) + r.offsetMs);
      const at = new Date(await bumpChangeClock(tx, t.tenantId, c.now));
      await tx.update(trucks).set({ state: 'at_gate', atGateAt: arrivedAt, version: bumped(trucks.version), updatedAt: at }).where(eq(trucks.id, t.id));
      await logActivity(tx, c.user, c.now, {
        entityType: 'order',
        entityId: t.orderId,
        orderId: t.orderId,
        action: 'truck.at_gate',
        meta: { subOrderId: t.subOrderId, truckId: t.id, vehicleNo: t.vehicleNo, restored: true },
      });
    }
    const result = await decideEvent(tx, d, r.event);
    if (result.status === 'rejected') throw new AppError(409, result.code, result.server);
    await tx.insert(syncEvents).values({
      tenantId: r.tenantId,
      clientEventId: r.clientEventId,
      userId: r.userId,
      truckId: r.truckId,
      status: 'accepted',
      code: null,
      message: null,
      createdAt: new Date(c.now),
    });
    await tx
      .update(weighmentRejections)
      .set({ status: 'restored', resolvedBy: c.user.id, resolvedAt: changedAt, updatedAt: changedAt })
      .where(eq(weighmentRejections.id, r.id));
  }

  const [restored] = await tx.select().from(weighmentRejections).where(eq(weighmentRejections.id, first.id));
  const [rejection] = await toRejections(tx, [restored!]);
  return {
    rejection: rejection!,
    truck: await truckResponse(tx, c, t.id),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** `POST /v1/weighment-rejections/:id/dismiss`: resolved at the change-clock time, so the sender's phone settles it. */
export async function dismissRejection(tx: Tx, c: OrderWriteCtx, id: string | undefined, reason: string): Promise<Rejection> {
  const r = await lockRejection(tx, id);
  assertOpen(r);
  const at = new Date(await bumpChangeClock(tx, r.tenantId, c.now));
  const [row] = await tx
    .update(weighmentRejections)
    .set({ status: 'dismissed', resolvedBy: c.user.id, resolvedAt: at, resolutionNote: reason, updatedAt: at })
    .where(eq(weighmentRejections.id, r.id))
    .returning();
  const [out] = await toRejections(tx, [row!]);
  return out!;
}
