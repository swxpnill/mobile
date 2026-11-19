import {
  type Rejection,
  type RejectionCount,
  type RestoreRejectionResult,
  type SyncEvent,
  dismissRejectionBodySchema,
  plantScope,
  rejectionsQuerySchema,
  subOrderNumber,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { applyEvent, currentWeighment, markArrived } from '../dispatch.ts';
import { ApiError, notFound } from '../errors.ts';
import { type OrderCtx, ctxFor } from '../order-views.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, RejectionRec, TruckRec } from '../store.ts';
import { toTruck } from '../truck-views.ts';
import { type Warning, overAssignable, vehicleBusy } from './trucks.ts';
import { type Authed, authed, logActivity } from '../views.ts';

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

function toRejection(c: OrderCtx, r: RejectionRec): Rejection {
  const truck = c.state.trucks.find((t) => t.id === r.truckId);
  const sub = truck ? c.state.subOrders.find((s) => s.id === truck.subOrderId) : undefined;
  const order = truck ? c.state.orders.find((o) => o.id === truck.orderId) : undefined;
  if (!truck || !sub || !order) throw new Error(`rejection ${r.id} has no truck`);
  const userRef = (id: string) => ({ id, name: c.userNameById.get(id) ?? '' });
  return {
    id: r.id,
    truckId: truck.id,
    vehicleNo: truck.vehicleNo,
    subOrderNumber: subOrderNumber(order.number, sub.suffix),
    plantName: c.state.plants.find((p) => p.id === truck.plantId)?.name ?? '',
    user: userRef(r.userId),
    eventType: r.event.type,
    payload: payloadOf(r.event),
    code: r.code,
    serverState: r.serverState,
    status: r.status,
    createdAt: r.createdAt,
    resolvedBy: r.resolvedBy === null ? null : userRef(r.resolvedBy),
    resolutionNote: r.resolutionNote,
  };
}

/** Rejection by id in the caller's tenant; 404 otherwise. Owner only, so no plant scope applies. */
function findRejection(state: MockState, a: Authed, id: string | undefined): RejectionRec {
  const r = state.rejections.find((x) => x.id === id && x.tenantId === a.user.tenantId);
  if (!r) throw notFound();
  return r;
}

function assertOpen(r: RejectionRec): void {
  if (r.status !== 'open') throw new ApiError(409, 'ALREADY_RESOLVED');
}

/**
 * Puts a cancelled truck back where its weighments leave it (a tare: loading; none: assigned).
 * Its plan counts as reserved again because the truck is open. A sub-order short closed or
 * cancelled since must be reopened first (ORDER_LOCKED).
 */
function reinstate(state: MockState, a: Authed, truck: TruckRec, now: number): void {
  const sub = state.subOrders.find((s) => s.id === truck.subOrderId);
  if (!sub) throw new Error(`truck ${truck.id} has no sub-order`);
  if (sub.closeKind === 'short_close' || sub.closeKind === 'cancel') throw new ApiError(409, 'ORDER_LOCKED');
  const hasTare = truck.tareKg !== null && currentWeighment(state, truck.id, 'tare') !== undefined;
  const at = toIso(now);
  truck.state = hasTare ? 'loading' : 'assigned';
  truck.cancelledAt = null;
  truck.cancelledBy = null;
  truck.cancelReason = null;
  truck.version += 1;
  truck.updatedAt = at;
  logActivity(state, a, now, {
    entityType: 'order',
    entityId: truck.orderId,
    action: 'truck.reinstated',
    meta: { subOrderId: truck.subOrderId, truckId: truck.id, vehicleNo: truck.vehicleNo, state: truck.state },
  });
}

/** The sender of a stored event, as they are now (a changed plant scope applies). */
function senderOf(state: MockState, a: Authed, r: RejectionRec): Authed {
  const user = state.users.find((u) => u.id === r.userId && u.tenantId === a.user.tenantId);
  if (!user) throw new Error(`rejection ${r.id} has no sender`);
  return { user, scope: plantScope(user), tenant: a.tenant };
}

export const rejectionRoutes: RouteDef[] = [
  route('GET', '/v1/weighment-rejections', {
    action: 'rejections.manage',
    query: rejectionsQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const c = ctxFor(ctx, a);
      const mine = ctx.state.rejections.filter(
        (r) => r.tenantId === a.user.tenantId && (ctx.query.status === 'all' || r.status === 'open'),
      );
      // Newest first; rows of one sync share a time, so the later event (stored later) comes first.
      const items = mine
        .reverse()
        .sort((x, y) => (x.createdAt === y.createdAt ? 0 : x.createdAt < y.createdAt ? 1 : -1))
        .map((r) => toRejection(c, r));
      return { body: items satisfies Rejection[] };
    },
  }),

  // Before any /v1/weighment-rejections/:id route.
  route('GET', '/v1/weighment-rejections/count', {
    action: 'rejections.manage',
    async handler(ctx) {
      const a = authed(ctx);
      const open = ctx.state.rejections.filter((r) => r.tenantId === a.user.tenantId && r.status === 'open').length;
      return { body: { open } satisfies RejectionCount };
    },
  }),

  route('POST', '/v1/weighment-rejections/:id/restore', {
    action: 'rejections.manage',
    idempotent: true,
    transactional: true,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      const first = findRejection(state, a, ctx.params.id);
      assertOpen(first);
      const truck = state.trucks.find((t) => t.id === first.truckId && t.tenantId === a.user.tenantId);
      if (!truck) throw notFound();
      // The phone's later events of this truck were blocked behind this one: they go with it, in order.
      const chain = [
        first,
        ...state.rejections
          .filter(
            (r) =>
              r.status === 'open' &&
              r.truckId === first.truckId &&
              r.deviceId === first.deviceId &&
              r.event.deviceSeq > first.event.deviceSeq,
          )
          .sort((x, y) => x.event.deviceSeq - y.event.deviceSeq),
      ];
      // Back on the road: warn as an assign would (another open truck has the vehicle, or the plan is
      // over what is left), checked before the truck counts as open again.
      const warnings: Warning[] = [];
      if (truck.state === 'cancelled') {
        const sub = state.subOrders.find((s) => s.id === truck.subOrderId);
        if (vehicleBusy(state, truck.tenantId, truck.vehicleNo, truck.id)) warnings.push('VEHICLE_BUSY');
        if (sub && overAssignable(ctxFor(ctx, a), sub, truck.plan)) warnings.push('OVER_ASSIGNABLE');
        reinstate(state, a, truck, now);
      }

      const at = toIso(now);
      for (const r of chain) {
        // Re-run as the original sender and phone, through the same dispatch code as a sync.
        delete state.appliedEvents[r.event.eventId];
        const dispatchCtx = { user: senderOf(state, a, r), deviceId: r.deviceId, now, offsetMs: r.offsetMs ?? 0 };
        // TON-57: a tare sent before "Vehicle arrived" (an outbox from before the rule) is restored
        // as arrival then tare; the arrival takes the tare's own business time.
        if (r.event.type === 'TARE' && truck.state === 'assigned') {
          markArrived(truck, toIso(Date.parse(r.event.capturedAtDevice) + dispatchCtx.offsetMs), at);
          logActivity(state, a, now, {
            entityType: 'order',
            entityId: truck.orderId,
            action: 'truck.at_gate',
            meta: { subOrderId: truck.subOrderId, truckId: truck.id, vehicleNo: truck.vehicleNo, restored: true },
          });
        }
        const result = applyEvent(state, dispatchCtx, r.event);
        if (result.status === 'rejected') throw new ApiError(409, result.code, result.server);
        r.status = 'restored';
        r.resolvedBy = a.user.id;
        r.resolvedAt = at;
      }
      const c = ctxFor(ctx, a);
      return {
        body: {
          rejection: toRejection(c, first),
          truck: toTruck(c, truck, { withWeighments: true }),
          ...(warnings.length > 0 ? { warnings } : {}),
        } satisfies RestoreRejectionResult,
      };
    },
  }),

  route('POST', '/v1/weighment-rejections/:id/dismiss', {
    action: 'rejections.manage',
    idempotent: true,
    transactional: true,
    body: dismissRejectionBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, body } = ctx;
      const r = findRejection(state, a, ctx.params.id);
      assertOpen(r);
      r.status = 'dismissed';
      r.resolvedBy = a.user.id;
      r.resolvedAt = toIso(now);
      r.resolutionNote = body.reason;
      return { body: toRejection(ctxFor(ctx, a), r) };
    },
  }),
];
