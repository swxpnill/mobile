import {
  type DoneToday,
  type SyncEvent,
  type SyncResponse,
  type SyncResult,
  type TasksPage,
  syncBodySchema,
} from '@tonnage/shared';
import { z } from 'zod';
import { fromIso, toIso } from '../clock.ts';
import { applyEvent } from '../dispatch.ts';
import { isOpenTruck } from '../orders-math.ts';
import { runEventTransaction } from '../pipeline.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, TruckRec } from '../store.ts';
import { boardOrder, sameIstDay, toTask } from '../truck-views.ts';
import { type Authed, authed, newId, plantInScope } from '../views.ts';

const tasksQuerySchema = z.object({ cursor: z.iso.datetime({ offset: true }).optional() });

const BLOCKED_MESSAGE = 'Blocked by an earlier rejected weight';

/** Trucks of the tenant at the caller's plant(s): every plant for owner, one for a supervisor. */
const myTrucks = (state: MockState, a: Authed): TruckRec[] =>
  state.trucks.filter((t) => t.tenantId === a.user.tenantId && plantInScope(a.scope, t.plantId));

/**
 * Device clock offset (server − device) from the phone's `X-Device-Time` at send time; 0 without
 * it or when it is not a date. Event times on the phone are never trusted on their own.
 */
function deviceOffsetMs(headers: Record<string, string>, now: number): number {
  const raw = headers['x-device-time'];
  if (raw === undefined) return 0;
  const device = Date.parse(raw);
  return Number.isFinite(device) ? now - device : 0;
}

type Rejected = Extract<SyncResult, { status: 'rejected' }>;

/** Keeps a refused event for Needs attention (§6.5), when its truck exists in the caller's tenant. */
function recordRejection(
  state: MockState,
  a: Authed,
  device: { deviceId: string; offsetMs: number },
  event: SyncEvent,
  r: Rejected,
  now: number,
): void {
  const truck = state.trucks.find((t) => t.id === event.truckId && t.tenantId === a.user.tenantId);
  if (!truck) return; // an id from nowhere: nothing to restore, nothing to show
  state.rejections.push({
    id: newId(),
    tenantId: a.user.tenantId,
    clientEventId: event.eventId,
    truckId: truck.id,
    userId: a.user.id,
    deviceId: device.deviceId,
    offsetMs: device.offsetMs,
    event,
    code: r.code,
    serverState: truck.state,
    status: 'open',
    createdAt: toIso(now),
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  });
}

export const supervisorRoutes: RouteDef[] = [
  route('GET', '/v1/supervisor/tasks', {
    action: 'tasks.view',
    query: tasksQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, query } = ctx;
      const mine = myTrucks(state, a);
      // At-least-once: a change at exactly the cursor is sent again (the phone replaces rows).
      const since = query.cursor === undefined ? null : fromIso(query.cursor);
      const changed = since === null ? mine : mine.filter((t) => fromIso(t.updatedAt) >= since);
      const items = changed.filter(isOpenTruck).sort(boardOrder).map((t) => toTask(state, t));
      // Tombstones: no longer open (cancelled, dispatched by another phone or the owner), or purged
      // with their order. A full pull (no cursor) is a snapshot and needs none.
      const graves = state.truckTombstones.filter(
        (g) => g.tenantId === a.user.tenantId && plantInScope(a.scope, g.plantId),
      );
      const removed =
        since === null
          ? []
          : [
              ...new Set([
                ...changed.filter((t) => !isOpenTruck(t)).map((t) => t.id),
                ...graves.filter((g) => fromIso(g.removedAt) >= since).map((g) => g.truckId),
              ]),
            ];
      // The newest change seen, deletions included (never moving back); the server time when there is nothing yet.
      const times = [...mine.map((t) => fromIso(t.updatedAt)), ...graves.map((g) => fromIso(g.removedAt))];
      if (since !== null) times.push(since);
      const cursor = toIso(times.length > 0 ? Math.max(...times) : now);
      return { body: { items, removed, cursor, serverTime: toIso(now) } satisfies TasksPage };
    },
  }),

  route('GET', '/v1/supervisor/done-today', {
    action: 'tasks.view',
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      // `dispatchedAt` is the gross weighment's business time, so a late sync counts on its own day.
      const done = myTrucks(state, a)
        .filter((t) => t.state === 'dispatched' && t.dispatchedAt !== null && sameIstDay(t.dispatchedAt, now))
        .sort(boardOrder);
      const items = done.map((t) => {
        const task = toTask(state, t);
        return {
          truckId: t.id,
          vehicleNo: t.vehicleNo,
          customerName: task.customerName,
          subOrderNumber: task.subOrderNumber,
          netKg: (t.grossKg ?? 0) - (t.tareKg ?? 0),
          loadingSlipNo: t.loadingSlipNo ?? '',
          dispatchedAt: t.dispatchedAt ?? '',
        };
      });
      const totalNetKg = items.reduce((n, x) => n + x.netKg, 0);
      return { body: { items, totalNetKg } satisfies DoneToday };
    },
  }),

  // Not route-transactional: each event commits or rolls back on its own (§6.4).
  route('POST', '/v1/weighments/sync', {
    action: 'weighment.capture',
    idempotent: true,
    body: syncBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, body } = ctx;
      const offsetMs = deviceOffsetMs(ctx.headers, now);
      const dispatchCtx = { user: a, deviceId: body.deviceId, now, offsetMs };
      // Trucks with a rejected event earlier in this request: their later events wait for the owner.
      const blocked = new Set<string>();
      const results: SyncResult[] = body.events.map((event) =>
        runEventTransaction(state, (): SyncResult => {
          if (state.appliedEvents[event.eventId]) return { status: 'duplicate', eventId: event.eventId };
          let r: SyncResult;
          if (blocked.has(event.truckId)) {
            // Only a truck the caller may see reports its state (a PLANT_SCOPE truck stays opaque).
            const truck = myTrucks(state, a).find((t) => t.id === event.truckId);
            r = {
              status: 'rejected',
              eventId: event.eventId,
              code: 'INVALID_STATE',
              message: BLOCKED_MESSAGE,
              ...(truck ? { server: { state: truck.state } } : {}),
            };
            state.appliedEvents[event.eventId] = { truckId: event.truckId, status: 'rejected' };
          } else {
            r = applyEvent(state, dispatchCtx, event);
          }
          if (r.status === 'rejected') {
            blocked.add(event.truckId);
            recordRejection(state, a, dispatchCtx, event, r, now);
          }
          return r;
        }),
      );
      return { body: { results, serverTime: toIso(now) } satisfies SyncResponse };
    },
  }),
];
