import {
  type DispatchBoard,
  type RecentVehicle,
  type Truck,
  assignTruckBodySchema,
  assignable,
  cancelTruckBodySchema,
  dispatchQuerySchema,
  editTruckBodySchema,
  isTerminal,
  istDateParts,
  nextTruckState,
  subOrderNumber,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, notFound, stale, validationError } from '../errors.ts';
import { type OrderCtx, ctxFor } from '../order-views.ts';
import { isOpenTruck } from '../orders-math.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, SubOrderRec, TruckRec } from '../store.ts';
import { boardOrder, newestFirst, toTruck, vehicleKey } from '../truck-views.ts';
import { type Authed, authed, logActivity, newId, plantInScope as inScope } from '../views.ts';
import { findSubOrder } from './order-lifecycle.ts';

type Warning = NonNullable<Truck['warnings']>[number];

const plantInScope = (a: Authed, plantId: string) => inScope(a.scope, plantId);

/** Truck by id in tenant and plant scope; 404 otherwise (identical for missing and out of scope). */
function findTruck(c: OrderCtx, id: string | undefined): TruckRec {
  const t = c.state.trucks.find((x) => x.id === id && x.tenantId === c.a.user.tenantId);
  if (!t || !plantInScope(c.a, t.plantId)) throw notFound();
  const sub = c.state.subOrders.find((s) => s.id === t.subOrderId);
  if (!sub || !c.visibleCompanyIds.has(sub.companyId)) throw notFound();
  return t;
}

const withWarnings = (truck: Truck, warnings: Warning[]): Truck =>
  warnings.length > 0 ? { ...truck, warnings } : truck;

/** Another open truck of the tenant with the same vehicle number. */
function vehicleBusy(state: MockState, tenantId: string, vehicleNo: string, exceptId?: string): boolean {
  const key = vehicleKey(vehicleNo);
  return state.trucks.some(
    (t) => t.tenantId === tenantId && t.id !== exceptId && isOpenTruck(t) && vehicleKey(t.vehicleNo) === key,
  );
}

/** Each plan row's line must be on this sub-order; the first stranger is reported. */
function assertPlanLines(c: OrderCtx, sub: SubOrderRec, plan: { orderLineId: string }[]): void {
  const lineIds = new Set(c.math.linesOf(sub.id).map((l) => l.id));
  const stranger = plan.find((p) => !lineIds.has(p.orderLineId));
  if (stranger) throw new ApiError(409, 'LINE_NOT_ON_ORDER', { lineId: stranger.orderLineId });
}

/** A plan row bigger than what is left to assign (the truck's own current plan is given back on edit). */
function overAssignable(
  c: OrderCtx,
  sub: SubOrderRec,
  plan: { orderLineId: string; plannedKg: number }[],
  own?: TruckRec,
): boolean {
  const lines = new Map(c.math.linesOf(sub.id).map((l) => [l.id, l]));
  return plan.some((p) => {
    const line = lines.get(p.orderLineId);
    if (!line) return false;
    const back = own?.plan.find((x) => x.orderLineId === p.orderLineId)?.plannedKg ?? 0;
    return p.plannedKg > assignable(c.math.lineQty(line)) + back;
  });
}

function checkTransporter(state: MockState, a: Authed, id: string | null | undefined): void {
  if (id === null || id === undefined) return;
  const p = state.parties.find((x) => x.id === id && x.tenantId === a.user.tenantId);
  if (!p || p.type !== 'transporter' || !p.active) {
    throw validationError([{ path: ['transporterId'], message: 'Choose an active transporter' }]);
  }
}

function sameIstDay(a: string | number, b: string | number): boolean {
  const x = istDateParts(a);
  const y = istDateParts(b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

const blankToNull = (v: string | null): string | null => (v === null || v === '' ? null : v);

export const truckRoutes: RouteDef[] = [
  route('POST', '/v1/sub-orders/:id/trucks', {
    action: 'truck.assign',
    idempotent: true,
    transactional: true,
    body: assignTruckBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const { sub, order } = findSubOrder(c, ctx.params.id);
      if (isTerminal(c.math.subOrderStatus(sub))) throw new ApiError(409, 'ORDER_LOCKED');
      if (order.customerId === null) throw new ApiError(409, 'CUSTOMER_REQUIRED');
      const company = state.companies.find((x) => x.id === sub.companyId);
      if (!company?.active) throw new ApiError(409, 'COMPANY_INACTIVE');

      const plants = state.plants.filter((p) => p.tenantId === a.user.tenantId && p.companyId === sub.companyId);
      let plant = body.plantId !== undefined ? plants.find((p) => p.id === body.plantId) : undefined;
      if (body.plantId !== undefined && !plant) {
        throw validationError([{ path: ['plantId'], message: "Choose one of this company's plants" }]);
      }
      if (!plant) {
        const active = plants.filter((p) => p.active);
        plant = plants.length === 1 ? plants[0] : active.length === 1 ? active[0] : undefined;
      }
      if (!plant) throw new ApiError(422, 'PLANT_REQUIRED');
      if (!plant.active) throw new ApiError(409, 'PLANT_INACTIVE');
      if (!plantInScope(a, plant.id)) throw notFound();
      checkTransporter(state, a, body.transporterId);
      assertPlanLines(c, sub, body.plan);

      const warnings: Warning[] = [];
      if (vehicleBusy(state, a.user.tenantId, body.vehicleNo)) warnings.push('VEHICLE_BUSY');
      if (overAssignable(c, sub, body.plan)) warnings.push('OVER_ASSIGNABLE');

      const at = toIso(now);
      const rec: TruckRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        orderId: order.id,
        subOrderId: sub.id,
        plantId: plant.id,
        vehicleNo: body.vehicleNo,
        transporterId: body.transporterId,
        driverName: body.driverName,
        driverPhone: body.driverPhone,
        lrNo: blankToNull(body.lrNo),
        state: 'assigned',
        tareKg: null,
        grossKg: null,
        plan: body.plan.map((p) => ({ ...p })),
        allocations: [],
        loadingSlipNo: null,
        assignedAt: at,
        assignedBy: a.user.id,
        atGateAt: null,
        tareAt: null,
        tareDeviceId: null,
        dispatchedAt: null,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.trucks.push(rec);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: 'truck.assigned',
        meta: { subOrderId: sub.id, truckId: rec.id, vehicleNo: rec.vehicleNo },
      });
      return { status: 201, body: withWarnings(toTruck(ctxFor(ctx, a), rec, { withWeighments: true }), warnings) };
    },
  }),

  route('PATCH', '/v1/trucks/:id', {
    action: 'truck.edit',
    transactional: true,
    body: editTruckBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const t = findTruck(c, ctx.params.id);
      if (body.version !== t.version) throw stale();
      const given = Object.entries(body)
        .filter(([k, v]) => k !== 'version' && v !== undefined)
        .map(([k]) => k);
      if (t.state === 'cancelled') throw new ApiError(409, 'TRUCK_LOCKED');
      if (t.state === 'dispatched' && given.some((k) => k !== 'lrNo')) throw new ApiError(409, 'TRUCK_LOCKED');
      const sub = state.subOrders.find((s) => s.id === t.subOrderId) as SubOrderRec;

      if (body.transporterId !== undefined) checkTransporter(state, a, body.transporterId);
      if (body.plan !== undefined) assertPlanLines(c, sub, body.plan);
      const warnings: Warning[] = [];
      const vehicleNo = body.vehicleNo ?? t.vehicleNo;
      if (body.vehicleNo !== undefined && vehicleBusy(state, t.tenantId, vehicleNo, t.id)) warnings.push('VEHICLE_BUSY');
      if (body.plan !== undefined && overAssignable(c, sub, body.plan, t)) warnings.push('OVER_ASSIGNABLE');

      t.vehicleNo = vehicleNo;
      if (body.transporterId !== undefined) t.transporterId = body.transporterId;
      if (body.driverName !== undefined) t.driverName = body.driverName;
      if (body.driverPhone !== undefined) t.driverPhone = body.driverPhone;
      if (body.lrNo !== undefined) t.lrNo = blankToNull(body.lrNo);
      if (body.plan !== undefined) t.plan = body.plan.map((p) => ({ ...p }));
      t.version += 1;
      t.updatedAt = toIso(now);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: t.orderId,
        action: 'truck.edited',
        meta: { subOrderId: t.subOrderId, truckId: t.id, vehicleNo: t.vehicleNo, fields: given },
      });
      return { body: withWarnings(toTruck(ctxFor(ctx, a), t, { withWeighments: true }), warnings) };
    },
  }),

  route('POST', '/v1/trucks/:id/cancel', {
    action: 'truck.cancel',
    transactional: true,
    body: cancelTruckBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const t = findTruck(ctxFor(ctx, a), ctx.params.id);
      if (body.version !== t.version) throw stale();
      const next = nextTruckState(t.state, 'cancel');
      if (next === null) throw new ApiError(409, 'TRUCK_LOCKED');
      const at = toIso(now);
      const note = body.note.trim();
      t.state = next;
      t.cancelledAt = at;
      t.cancelledBy = a.user.id;
      t.cancelReason = note === '' ? body.reason : `${body.reason} — ${note}`;
      t.version += 1;
      t.updatedAt = at;
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: t.orderId,
        action: 'truck.cancelled',
        meta: { subOrderId: t.subOrderId, truckId: t.id, vehicleNo: t.vehicleNo, reason: body.reason },
      });
      return { body: toTruck(ctxFor(ctx, a), t, { withWeighments: true }) };
    },
  }),

  // Before /v1/trucks/:id, or "recent-vehicles" is read as a truck id.
  route('GET', '/v1/trucks/recent-vehicles', {
    action: 'truck.assign',
    async handler(ctx) {
      const a = authed(ctx);
      const mine = ctx.state.trucks.filter((t) => t.tenantId === a.user.tenantId).sort(newestFirst);
      const seen = new Set<string>();
      const out: RecentVehicle[] = [];
      for (const t of mine) {
        const key = vehicleKey(t.vehicleNo);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          vehicleNo: t.vehicleNo,
          transporterId: t.transporterId,
          driverName: t.driverName,
          driverPhone: t.driverPhone,
        });
        if (out.length === 8) break;
      }
      return { body: out };
    },
  }),

  route('GET', '/v1/trucks/:id', {
    action: 'dispatch.view',
    async handler(ctx) {
      const a = authed(ctx);
      const c = ctxFor(ctx, a);
      return { body: toTruck(c, findTruck(c, ctx.params.id), { withWeighments: true }) };
    },
  }),

  route('GET', '/v1/dispatch', {
    action: 'dispatch.view',
    query: dispatchQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, query } = ctx;
      const c = ctxFor(ctx, a);
      const counts = { assigned: 0, at_gate: 0, loading: 0, dispatched_today: 0 };
      if (query.companyId !== undefined && !c.visibleCompanyIds.has(query.companyId)) {
        return { body: { counts, items: [] } satisfies DispatchBoard };
      }

      const subById = new Map(state.subOrders.map((s) => [s.id, s]));
      const inScope = state.trucks.filter((t) => {
        if (t.tenantId !== a.user.tenantId || !plantInScope(a, t.plantId)) return false;
        const sub = subById.get(t.subOrderId);
        if (!sub || !c.visibleCompanyIds.has(sub.companyId)) return false;
        return query.companyId === undefined || sub.companyId === query.companyId;
      });
      const isToday = (t: TruckRec) =>
        t.state === 'dispatched' && t.dispatchedAt !== null && sameIstDay(t.dispatchedAt, now);
      for (const t of inScope) {
        if (isToday(t)) counts.dispatched_today += 1;
        else if (t.state === 'assigned' || t.state === 'at_gate' || t.state === 'loading') counts[t.state] += 1;
      }

      const needle = query.q === undefined ? '' : query.q.trim().toLowerCase();
      const matches = (t: TruckRec): boolean => {
        if (needle === '') return true;
        const sub = subById.get(t.subOrderId) as SubOrderRec;
        const order = state.orders.find((o) => o.id === t.orderId);
        const customer = order?.customerId ? (c.partyById.get(order.customerId)?.name ?? '') : '';
        const hay = [
          t.vehicleNo.toLowerCase(),
          vehicleKey(t.vehicleNo),
          (order?.number ?? '').toLowerCase(),
          subOrderNumber(order?.number ?? '', sub.suffix).toLowerCase(),
          customer.toLowerCase(),
        ];
        return hay.some((h) => h.includes(needle) || h.includes(vehicleKey(needle)));
      };
      const wanted = (t: TruckRec): boolean => {
        if (query.state === 'dispatched_today') return isToday(t);
        if (query.state === 'open') return isOpenTruck(t);
        return t.state === query.state;
      };
      const items = inScope
        .filter((t) => wanted(t) && matches(t))
        .sort(boardOrder)
        .map((t) => {
          const full = toTruck(c, t, { withWeighments: false }) as Partial<Truck>;
          delete full.weighments;
          return full as Omit<Truck, 'weighments'>;
        });
      return { body: { counts, items } satisfies DispatchBoard };
    },
  }),
];
