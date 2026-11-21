import {
  CLOCK_SKEW_FLAG_MS,
  type SyncEvent,
  type SyncRejectCode,
  type SyncResult,
  checkAllocations,
  earningFromRates,
  formatLoadingSlip,
  netKg,
  overToleranceKg,
  toleranceCloseKg,
  truckEarning,
} from '@tonnage/shared';
import { notifyArrived, notifyDispatched, notifyOverTolerance, notifyWeighed } from './notifications.ts';
import { toIso } from './clock.ts';
import { errorMessage } from './errors.ts';
import { nextNumber, orderMath } from './orders-math.ts';
import type { BrokerLedgerRec, MockState, TruckRec, WeighmentRec } from './store.ts';
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
 * snapshot/rollback and copies rejections into `state.rejections` (Task 5). Every outcome is kept
 * in `appliedEvents` (truck, status, a refusal's code and message), so a replay of the same `eventId` gets the same answer and changes nothing
 * (`duplicate` when it was accepted, the same refusal when it was rejected).
 */
export function applyEvent(state: MockState, ctx: DispatchCtx, event: SyncEvent): SyncResult {
  const seen = replayed(state, event.eventId);
  if (seen) return seen;
  const result = decide(state, ctx, event);
  remember(state, event, result);
  return result;
}

/**
 * The answer to an event id seen before, or null: `duplicate` for an accepted event; a rejected
 * one is refused again with the same code and message (no new rejection row, no state change).
 */
export function replayed(state: MockState, eventId: string): SyncResult | null {
  const seen = state.appliedEvents[eventId];
  if (!seen) return null;
  if (seen.status === 'accepted') return { status: 'duplicate', eventId };
  return { status: 'rejected', eventId, code: seen.code, message: seen.message };
}

/** Keeps an outcome in `appliedEvents`: truck and status, plus a refusal's code and message. */
export function remember(state: MockState, event: SyncEvent, result: SyncResult): void {
  if (result.status === 'accepted') state.appliedEvents[event.eventId] = { truckId: event.truckId, status: 'accepted' };
  else if (result.status === 'rejected')
    state.appliedEvents[event.eventId] = { truckId: event.truckId, status: 'rejected', code: result.code, message: result.message };
}

function decide(state: MockState, ctx: DispatchCtx, event: SyncEvent): SyncResult {
  const { user: a } = ctx;
  const id = event.eventId;
  const truck = state.trucks.find((t) => t.id === event.truckId && t.tenantId === a.user.tenantId);
  if (!truck || (a.scope.kind === 'plants' && !a.scope.plantIds.includes(truck.plantId))) {
    return reject(id, 'PLANT_SCOPE');
  }
  const atState = (): Rejected['server'] => ({ state: truck.state });
  // Past the phone's part: weighed (awaiting the office), dispatched or cancelled.
  const done = truck.state === 'cancelled' || truck.state === 'dispatched' || truck.state === 'weighed';
  // An arrival may reach the server late: on a truck past it, it is a no-op, not a refusal.
  if (event.type === 'AT_GATE' && done) return { status: 'accepted', eventId: id, task: null };
  if (truck.state === 'cancelled') return reject(id, 'TRUCK_CANCELLED', atState());
  if (truck.state === 'dispatched') return reject(id, 'ALREADY_DISPATCHED', atState());
  // TON-57: the weights are with the office; it changes them, the phone no longer can.
  if (truck.state === 'weighed') return reject(id, 'ALREADY_WEIGHED', atState());

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
  // A weighed truck has left the phone's tasks (the office approves it).
  const accepted = (): SyncResult => ({
    status: 'accepted',
    eventId: id,
    task: truck.state === 'weighed' ? null : toTask(state, truck),
  });

  switch (event.type) {
    case 'AT_GATE': {
      // "Vehicle arrived" (TON-57). A late or repeated one changes nothing once the truck is past it.
      if (truck.state !== 'assigned') return accepted();
      markArrived(truck, w.capturedAt, now);
      log('truck.at_gate');
      // Ruling 21: only a real arrival tells anyone (a late or repeated one returned above).
      notifyArrived(state, a, ctx.now, truck, w.capturedAt);
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
      // TON-57: tare only after "Vehicle arrived". The phone always queues AT_GATE first, so this
      // catches an outbox from before the rule; Restore marks the arrival and applies the tare.
      if (truck.state === 'assigned') return reject(id, 'ARRIVAL_REQUIRED', atState());
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

      // TON-57: the weights go to the office for approval; nothing is dispatched yet (no slip,
      // no earning, no tolerance close). `approveDispatch` does that.
      weigh('gross', event.grossKg);
      truck.state = 'weighed';
      truck.grossKg = event.grossKg;
      truck.allocations = event.allocations.map((x) => ({ orderLineId: x.orderLineId, netKg: x.netKg }));
      truck.weighedAt = w.capturedAt;
      bump(truck, now);
      log('truck.weighed', { netKg: net });
      notifyWeighed(state, a, ctx.now, truck, net);
      return accepted();
    }
  }
}

/**
 * TON-57: the office approves a weighed truck, and that is the dispatch (§5.2), in the caller's
 * transaction: dispatched at `nowMs`, the loading slip numbered then, the broker earning, the
 * dispatch notifications, then the sub-order's tolerance close. The caller checks the state.
 */
export function approveDispatch(state: MockState, a: Authed, nowMs: number, truck: TruckRec): void {
  if (truck.state !== 'weighed' || truck.grossKg === null || truck.tareKg === null) {
    throw new Error(`truck ${truck.id} is not awaiting approval`);
  }
  const at = toIso(nowMs);
  const net = netKg(truck.grossKg, truck.tareKg);
  truck.state = 'dispatched';
  truck.dispatchedAt = at;
  truck.loadingSlipNo = issueLoadingSlip(state, truck, at);
  bump(truck, at);
  writeEarning(state, truck, at, a.user.id);
  logActivity(state, a, nowMs, {
    entityType: 'order',
    entityId: truck.orderId,
    action: 'truck.dispatched',
    meta: { subOrderId: truck.subOrderId, truckId: truck.id, vehicleNo: truck.vehicleNo, netKg: net, loadingSlipNo: truck.loadingSlipNo },
  });
  notifyDispatched(state, a, nowMs, truck, net);
  closeWithinTolerance(state, { user: a, deviceId: 'server', now: nowMs, offsetMs: 0 }, truck, at);
}

/** The truck is at the plant: `at_gate` ("Arrived"), at `capturedAt` business time. */
export function markArrived(truck: TruckRec, capturedAt: string, now: string): void {
  truck.state = 'at_gate';
  truck.atGateAt = capturedAt;
  bump(truck, now);
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
export function closeWithinTolerance(state: MockState, ctx: DispatchCtx, truck: TruckRec, at: string): void {
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
    notifyOverTolerance(state, ctx.user, ctx.now, sub, overKg);
  }
}

/**
 * Undoes a tolerance close of the truck's sub-order (a weight correction re-evaluates it): the
 * lines' closed kg go back to 0 and the sub-order is open again. Nothing for other close kinds.
 */
export function undoToleranceClose(state: MockState, truck: TruckRec, at: string): void {
  const sub = state.subOrders.find((s) => s.id === truck.subOrderId);
  if (!sub || sub.closeKind !== 'tolerance') return;
  for (const l of state.orderLines) {
    if (l.subOrderId !== sub.id || l.closedKg === 0) continue;
    l.closedKg = 0;
    bump(l, at);
  }
  Object.assign(sub, { closeKind: null, closeReason: null, closeNote: null, closedAt: null, closedBy: null });
  bump(sub, at);
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
  pushEarning(state, truck, order.brokerId, truckEarning(truck.allocations, lines, order.commissionPerMtSnapshot ?? 0), at, actorId);
}

/**
 * A weight correction's earning (§5.2): reverses the current earning, then writes a new one for
 * the truck's new allocations at the reversed earning's per-MT rates (the rates at dispatch).
 * A line the old earning did not cover takes the order's snapshot commission plus its overprice.
 */
export function rewriteEarning(state: MockState, truck: TruckRec, at: string, actorId: string): void {
  const old = reverseEarning(state, truck, at, actorId);
  if (!old) {
    writeEarning(state, truck, at, actorId);
    return;
  }
  const order = state.orders.find((o) => o.id === truck.orderId);
  if (!order) throw new Error(`truck ${truck.id} has no order`);
  const atDispatch = new Map(
    old.breakdown.map((b) => [b.orderLineId, { commissionPerMt: b.commissionPerMt, overpricePerMt: b.overpricePerMt }]),
  );
  const commission = order.commissionPerMtSnapshot ?? 0;
  const rates = new Map(
    state.orderLines
      .filter((l) => l.subOrderId === truck.subOrderId)
      .map((l) => [l.id, atDispatch.get(l.id) ?? { commissionPerMt: commission, overpricePerMt: l.overpricePerMt }]),
  );
  pushEarning(state, truck, old.brokerId, earningFromRates(truck.allocations, rates), at, actorId);
}

/** The payment-only fields of a ledger row that is not a payment. */
const NO_PAYMENT = { mode: null, utr: null, tdsRupees: null, paidRupees: null, paidOn: null, note: null } as const;

function pushEarning(
  state: MockState,
  truck: TruckRec,
  brokerId: string,
  { earningRupees, breakdown }: ReturnType<typeof truckEarning>,
  at: string,
  actorId: string,
): void {
  state.brokerLedger.push({
    id: newId(),
    tenantId: truck.tenantId,
    brokerId,
    kind: 'earning',
    truckId: truck.id,
    amountRupees: earningRupees,
    breakdown,
    reversesId: null,
    createdAt: at,
    createdBy: actorId,
    ...NO_PAYMENT,
  });
}

/**
 * Appends the exact negation of the truck's latest earning not yet reversed and returns that
 * earning; nothing (undefined) if there is none.
 */
export function reverseEarning(state: MockState, truck: TruckRec, at: string, actorId: string): BrokerLedgerRec | undefined {
  const rows = state.brokerLedger.filter((r) => r.truckId === truck.id);
  const reversed = new Set(rows.map((r) => r.reversesId).filter((x): x is string => x !== null));
  const earning = lastOf(rows, (r) => r.kind === 'earning' && !reversed.has(r.id));
  if (!earning) return undefined;
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
    ...NO_PAYMENT,
  });
  return earning;
}

/** `Array.prototype.findLast` (ES2023, outside this package's lib). */
function lastOf<T>(items: readonly T[], pred: (x: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const x = items[i];
    if (x !== undefined && pred(x)) return x;
  }
  return undefined;
}
