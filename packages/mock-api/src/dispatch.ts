import {
  CLOCK_SKEW_FLAG_MS,
  type SyncEvent,
  type SyncRejectCode,
  type SyncResult,
  checkAllocations,
  formatLoadingSlip,
  netKg,
  overToleranceKg,
  toleranceCloseKg,
  truckEarning,
} from '@tonnage/shared';
import { toIso } from './clock.ts';
import { errorMessage } from './errors.ts';
import { nextNumber, orderMath } from './orders-math.ts';
import type { MockState, TruckRec, WeighmentRec } from './store.ts';
import { toTask } from './truck-views.ts';
import { type Authed, logActivity, newId } from './views.ts';

export interface DispatchCtx {
  user: Authed;
  deviceId: string;
  /** Server time the event is received. */
  now: number;
  /** Device clock offset (server − device), added to `capturedAtDevice` for business time. */
  offsetMs: number;
}

type Rejected = Extract<SyncResult, { status: 'rejected' }>;

const reject = (eventId: string, code: SyncRejectCode, server?: Rejected['server']): Rejected =>
  server ? { status: 'rejected', eventId, code, message: errorMessage(code), server } : { status: 'rejected', eventId, code, message: errorMessage(code) };

const bump = (t: { version: number; updatedAt: string }, at: string) => {
  t.version += 1;
  t.updatedAt = at;
};

/**
 * Applies one supervisor sync event to the state: the §6.5 table, first match wins. Business
 * refusals come back as `rejected` (never thrown); the caller runs each event in its own
 * snapshot/rollback and copies rejections into `state.rejections` (Task 5). Every outcome is kept,
 * as its truck and status only,
 * in `appliedEvents`, so a replay of the same `eventId` is answered `duplicate` and changes nothing.
 */
export function applyEvent(state: MockState, ctx: DispatchCtx, event: SyncEvent): SyncResult {
  if (state.appliedEvents[event.eventId]) return { status: 'duplicate', eventId: event.eventId };
  const result = decide(state, ctx, event);
  if (result.status !== 'duplicate') state.appliedEvents[event.eventId] = { truckId: event.truckId, status: result.status };
  return result;
}

function decide(state: MockState, ctx: DispatchCtx, event: SyncEvent): SyncResult {
  const { user: a } = ctx;
  const id = event.eventId;
  const truck = state.trucks.find((t) => t.id === event.truckId && t.tenantId === a.user.tenantId);
  if (!truck || (a.scope.kind === 'plants' && !a.scope.plantIds.includes(truck.plantId))) {
    return reject(id, 'PLANT_SCOPE');
  }
  const atState = (): Rejected['server'] => ({ state: truck.state });
  if (truck.state === 'cancelled') return reject(id, 'TRUCK_CANCELLED', atState());
  if (truck.state === 'dispatched') return reject(id, 'ALREADY_DISPATCHED', atState());

  const w = {
    capturedAtDevice: event.capturedAtDevice,
    capturedAt: toIso(Date.parse(event.capturedAtDevice) + ctx.offsetMs),
    receivedAt: toIso(ctx.now),
    clockSkewFlag: Math.abs(ctx.offsetMs) > CLOCK_SKEW_FLAG_MS,
  };
  const now = w.receivedAt;
  const order = state.orders.find((o) => o.id === truck.orderId);
  if (!order) throw new Error(`truck ${truck.id} has no order`);
  const log = (action: string, meta: Record<string, unknown> = {}) =>
    logActivity(state, a, ctx.now, {
      entityType: 'order',
      entityId: order.id,
      action,
      meta: {
        subOrderId: truck.subOrderId,
        truckId: truck.id,
        vehicleNo: truck.vehicleNo,
        ...meta,
        ...(w.clockSkewFlag ? { clockSkew: true } : {}),
      },
    });
  const weigh = (kind: WeighmentRec['kind'], kg: number): WeighmentRec => {
    const rec: WeighmentRec = {
      id: newId(),
      tenantId: truck.tenantId,
      truckId: truck.id,
      kind,
      kg,
      enteredBy: a.user.id,
      deviceId: ctx.deviceId,
      clientEventId: id,
      ...w,
      supersededBy: null,
    };
    state.weighments.push(rec);
    return rec;
  };
  const accepted = (extra: { loadingSlipNo?: string } = {}): SyncResult => ({
    status: 'accepted',
    eventId: id,
    task: truck.state === 'dispatched' ? null : toTask(state, truck),
    ...extra,
  });

  switch (event.type) {
    case 'AT_GATE': {
      // The gate step is optional and the phone may send it late: after it, it changes nothing.
      if (truck.state !== 'assigned') return accepted();
      truck.state = 'at_gate';
      truck.atGateAt = w.capturedAt;
      bump(truck, now);
      log('truck.at_gate');
      return accepted();
    }

    case 'TARE': {
      if (truck.state === 'loading') {
        if (truck.tareDeviceId !== ctx.deviceId) {
          const current = currentWeighment(state, truck.id, 'tare');
          const by = current ? state.users.find((u) => u.id === current.enteredBy)?.name : undefined;
          return reject(id, 'TARE_CONFLICT', {
            ...(truck.tareKg !== null ? { tareKg: truck.tareKg } : {}),
            ...(by !== undefined ? { by } : {}),
            ...(truck.tareAt !== null ? { at: truck.tareAt } : {}),
            state: truck.state,
          });
        }
        // Same phone: the supervisor fixed a typo before the gross.
        const previous = currentWeighment(state, truck.id, 'tare');
        const rec = weigh('tare', event.tareKg);
        if (previous) previous.supersededBy = rec.id;
        const fromKg = truck.tareKg;
        setTare(truck, rec, ctx.deviceId);
        bump(truck, now);
        log('truck.tare_corrected', { tareKg: event.tareKg, previousTareKg: fromKg });
        return accepted();
      }
      // assigned | at_gate
      setTare(truck, weigh('tare', event.tareKg), ctx.deviceId);
      truck.state = 'loading';
      bump(truck, now);
      log('truck.tare', { tareKg: event.tareKg });
      return accepted();
    }

    case 'GROSS': {
      if (truck.tareKg === null) return reject(id, 'TARE_REQUIRED', atState());
      if (truck.state !== 'loading') return reject(id, 'INVALID_STATE', atState());
      const net = netKg(event.grossKg, truck.tareKg);
      const lineIds = new Set(state.orderLines.filter((l) => l.subOrderId === truck.subOrderId).map((l) => l.id));
      const check = checkAllocations(net, event.allocations, lineIds);
      if (check !== 'ok') return reject(id, check, atState());

      weigh('gross', event.grossKg);
      truck.state = 'dispatched';
      truck.grossKg = event.grossKg;
      truck.allocations = event.allocations.map((x) => ({ orderLineId: x.orderLineId, netKg: x.netKg }));
      truck.dispatchedAt = w.capturedAt;
      truck.loadingSlipNo = issueLoadingSlip(state, truck, w.capturedAt);
      bump(truck, now);
      writeEarning(state, truck, now, a.user.id);
      log('truck.dispatched', { netKg: net, loadingSlipNo: truck.loadingSlipNo });
      closeWithinTolerance(state, ctx, truck, now);
      return accepted({ loadingSlipNo: truck.loadingSlipNo });
    }
  }
}

function setTare(truck: TruckRec, rec: WeighmentRec, deviceId: string): void {
  truck.tareKg = rec.kg;
  truck.tareAt = rec.capturedAt;
  truck.tareDeviceId = deviceId;
}

/** The truck's live (not superseded) weighment of a kind, if any. */
export function currentWeighment(state: MockState, truckId: string, kind: WeighmentRec['kind']): WeighmentRec | undefined {
  return lastOf(state.weighments, (x) => x.truckId === truckId && x.kind === kind && x.supersededBy === null);
}

/** `LS-<Company>-YYMM-NNNN`, one series per company per financial year (§5.3), at business time. */
export function issueLoadingSlip(state: MockState, truck: TruckRec, at: string): string {
  const sub = state.subOrders.find((s) => s.id === truck.subOrderId);
  const company = sub ? state.companies.find((c) => c.id === sub.companyId) : undefined;
  if (!company) throw new Error(`truck ${truck.id} has no company`);
  return formatLoadingSlip(company.code, at, nextNumber(state, truck.tenantId, `ls:${company.id}`, at));
}

/**
 * §5.1 tolerance in the dispatch transaction: when pending is within the tenant's tolerance and
 * nothing else is open on the sub-order, close the rest; flag a sub-order over by more than it.
 */
function closeWithinTolerance(state: MockState, ctx: DispatchCtx, truck: TruckRec, at: string): void {
  const sub = state.subOrders.find((s) => s.id === truck.subOrderId);
  if (!sub) throw new Error(`truck ${truck.id} has no sub-order`);
  const toleranceKg = ctx.user.tenant.settings.completionToleranceKg;
  const math = orderMath(state);
  const lines = math.linesOf(sub.id);
  const qtys = lines.map(math.lineQty);
  const closeKg = sub.closeKind === null ? toleranceCloseKg(qtys, toleranceKg, math.openTrucksOf(sub.id).length) : null;
  if (closeKg) {
    lines.forEach((l, i) => {
      const kg = closeKg[i] ?? 0;
      if (kg === 0) return;
      l.closedKg += kg;
      bump(l, at);
    });
    sub.closeKind = 'tolerance';
    sub.closeReason = 'Within tolerance';
    sub.closedAt = at;
    sub.closedBy = ctx.user.user.id;
    bump(sub, at);
  }
  const overKg = overToleranceKg(qtys, toleranceKg);
  if (overKg > 0) {
    logActivity(state, ctx.user, ctx.now, {
      entityType: 'order',
      entityId: truck.orderId,
      action: 'order.over_tolerance',
      meta: { subOrderId: sub.id, kg: overKg },
    });
  }
}

/**
 * Appends the truck's broker earning (§5.4) from its allocations, at the order's commission
 * snapshot plus each line's overprice. Nothing when the order has no broker.
 */
export function writeEarning(state: MockState, truck: TruckRec, at: string, actorId: string): void {
  const order = state.orders.find((o) => o.id === truck.orderId);
  if (!order) throw new Error(`truck ${truck.id} has no order`);
  if (order.brokerId === null) return;
  const lines = new Map(state.orderLines.filter((l) => l.subOrderId === truck.subOrderId).map((l) => [l.id, l]));
  const { earningRupees, breakdown } = truckEarning(truck.allocations, lines, order.commissionPerMtSnapshot ?? 0);
  state.brokerLedger.push({
    id: newId(),
    tenantId: truck.tenantId,
    brokerId: order.brokerId,
    kind: 'earning',
    truckId: truck.id,
    amountRupees: earningRupees,
    breakdown,
    reversesId: null,
    createdAt: at,
    createdBy: actorId,
  });
}

/** Appends the exact negation of the truck's latest earning not yet reversed; nothing if none. */
export function reverseEarning(state: MockState, truck: TruckRec, at: string, actorId: string): void {
  const rows = state.brokerLedger.filter((r) => r.truckId === truck.id);
  const reversed = new Set(rows.map((r) => r.reversesId).filter((x): x is string => x !== null));
  const earning = lastOf(rows, (r) => r.kind === 'earning' && !reversed.has(r.id));
  if (!earning) return;
  state.brokerLedger.push({
    id: newId(),
    tenantId: earning.tenantId,
    brokerId: earning.brokerId,
    kind: 'reversal',
    truckId: truck.id,
    amountRupees: -earning.amountRupees,
    breakdown: earning.breakdown.map((b) => ({ ...b, netKg: -b.netKg })),
    reversesId: earning.id,
    createdAt: at,
    createdBy: actorId,
  });
}

/** `Array.prototype.findLast` (ES2023, outside this package's lib). */
function lastOf<T>(items: readonly T[], pred: (x: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const x = items[i];
    if (x !== undefined && pred(x)) return x;
  }
  return undefined;
}
