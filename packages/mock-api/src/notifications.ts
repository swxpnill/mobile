import {
  type Notification,
  type NotificationContent,
  type NotificationKind,
  type NotifyEvent,
  type PaymentMode,
  type PushMessage,
  type RecipientUser,
  type SyncRejectCode,
  deepLinkFor,
  istDateOf,
  notificationSchema,
  plantScope,
  recipientsFor,
  subOrderNumber,
} from '@tonnage/shared';
import { DAY, MINUTE, fromIso, toIso } from './clock.ts';
import { ctxFor, toSummary } from './order-views.ts';
import type { MockState, NotificationRec, OrderRec, SubOrderRec, TenantRec, TruckRec, UserRec } from './store.ts';
import { type Authed, newId } from './views.ts';

/** F5 Ruling 5: the list keeps 30 days, 30 rows a page. */
export const NOTIFICATION_RETENTION_MS = 30 * DAY;
export const NOTIFICATION_PAGE = 30;
/** F5 Ruling 6: the aged-orders digest runs from 09:00 IST. */
const DIGEST_FROM_IST_MINUTE = 9 * 60;
const IST_OFFSET_MS = 330 * MINUTE;

type DataOf<K extends NotificationKind> = Extract<NotificationContent, { kind: K }>['data'];

// ── lookups ────────────────────────────────────────────────────────────────────────────────────

const tenantOf = (state: MockState, id: string) => state.tenants.find((t) => t.id === id);
const partyName = (state: MockState, order: OrderRec) =>
  state.parties.find((p) => p.id === (order.customerId ?? order.brokerId))?.name ?? 'Customer not added yet';
const subsOf = (state: MockState, orderId: string) =>
  state.subOrders.filter((s) => s.orderId === orderId).sort((x, y) => x.suffix.localeCompare(y.suffix));
const companyOf = (state: MockState, id: string) => state.companies.find((c) => c.id === id);
const plantsOfCompanies = (state: MockState, tenantId: string, companyIds: readonly string[]) =>
  state.plants.filter((p) => p.tenantId === tenantId && companyIds.includes(p.companyId)).map((p) => p.id);

/** Companies a person sees: all for owner and city staff, else those of their plants. */
function companiesSeenBy(state: MockState, u: UserRec): Set<string> | 'all' {
  const scope = plantScope(u);
  if (scope.kind === 'all') return 'all';
  return new Set(state.plants.filter((p) => scope.plantIds.includes(p.id)).map((p) => p.companyId));
}

const recipientUsers = (state: MockState, tenantId: string): RecipientUser[] =>
  state.users
    .filter((u) => u.tenantId === tenantId)
    .map((u) => ({ id: u.id, role: u.role, active: u.active, plantIds: u.plantIds }));

// ── writing ────────────────────────────────────────────────────────────────────────────────────

interface Delivery<K extends NotificationKind> {
  tenantId: string;
  event: NotifyEvent & { kind: K };
  orderId: string | null;
  /** The payload for this person, from what they may see; null = nothing for them. */
  dataFor(user: UserRec): DataOf<K> | null;
}

/**
 * Writes one row per recipient plus their push-outbox rows, inside the caller's transaction:
 * a write that rolls back takes its notifications with it (F5 Review Focus 1).
 */
function deliver<K extends NotificationKind>(state: MockState, now: number, d: Delivery<K>): void {
  const at = toIso(now);
  for (const r of recipientsFor(d.event, recipientUsers(state, d.tenantId))) {
    const user = state.users.find((u) => u.id === r.userId);
    const data = user ? d.dataFor(user) : null;
    if (!user || !data) continue;
    const content = { kind: d.event.kind, data } as NotificationContent;
    const rec: NotificationRec = {
      id: newId(),
      tenantId: d.tenantId,
      userId: user.id,
      kind: content.kind,
      data: content.data as Record<string, unknown>,
      deepLink: deepLinkFor(content, user.role),
      readAt: null,
      createdAt: at,
      orderId: d.orderId,
    };
    // The mock answers like the real API: a payload that breaks the contract is a bug, not a row.
    notificationSchema.parse(toNotification(rec));
    state.notifications.push(rec);
    // `row`: the list row only, nothing pushed (TON-57 Ruling 21).
    if (r.delivery !== 'row') {
      state.pushOutbox.push({ id: newId(), userId: user.id, message: { type: 'alert', notificationId: rec.id }, orderId: d.orderId });
    }
    if (r.delivery === 'row-and-sync') {
      state.pushOutbox.push({ id: newId(), userId: user.id, message: { type: 'sync' }, orderId: d.orderId });
    }
  }
}

/** A silent "sync now" for the active supervisors of these plants (their tasks changed). */
export function queueSync(state: MockState, tenantId: string, plantIds: readonly string[], orderId: string | null): void {
  const plants = new Set(plantIds);
  for (const u of state.users) {
    if (u.tenantId !== tenantId || !u.active || u.role !== 'supervisor') continue;
    if (!u.plantIds.some((p) => plants.has(p))) continue;
    state.pushOutbox.push({ id: newId(), userId: u.id, message: { type: 'sync' }, orderId });
  }
}

export function notifyOrderCreated(state: MockState, a: Authed, now: number, order: OrderRec): void {
  const subs = subsOf(state, order.id);
  const companyIds = subs.map((s) => s.companyId);
  deliver(state, now, {
    tenantId: order.tenantId,
    orderId: order.id,
    event: { kind: 'order.created', actorId: a.user.id, plantIds: plantsOfCompanies(state, order.tenantId, companyIds) },
    dataFor(u) {
      const seen = companiesSeenBy(state, u);
      const mine = subs.filter((s) => seen === 'all' || seen.has(s.companyId));
      if (mine.length === 0) return null;
      const subIds = new Set(mine.map((s) => s.id));
      return {
        orderId: order.id,
        orderNumber: order.number,
        actorName: a.user.name,
        partyName: partyName(state, order),
        orderedKg: state.orderLines.filter((l) => subIds.has(l.subOrderId)).reduce((sum, l) => sum + l.orderedKg, 0),
        companyCodes: mine.map((s) => companyOf(state, s.companyId)?.code ?? '?'),
      };
    },
  });
}

function truckContext(state: MockState, truck: TruckRec) {
  const order = state.orders.find((o) => o.id === truck.orderId);
  const sub = state.subOrders.find((s) => s.id === truck.subOrderId);
  if (!order || !sub) throw new Error(`truck ${truck.id} has no order`);
  return { order, sub };
}

export function notifyTruckAssigned(state: MockState, a: Authed, now: number, truck: TruckRec): void {
  const { order } = truckContext(state, truck);
  const data: DataOf<'truck.assigned'> = {
    truckId: truck.id,
    orderId: order.id,
    vehicleNo: truck.vehicleNo,
    plannedKg: truck.plan.reduce((sum, p) => sum + p.plannedKg, 0),
    partyName: partyName(state, order),
    plantName: state.plants.find((p) => p.id === truck.plantId)?.name ?? '?',
  };
  deliver(state, now, {
    tenantId: truck.tenantId,
    orderId: order.id,
    event: { kind: 'truck.assigned', actorId: a.user.id, plantIds: [truck.plantId] },
    dataFor: () => data,
  });
}

/** A truck was edited or cancelled: its plant's supervisors pull again. */
export function notifyTruckChanged(state: MockState, truck: TruckRec): void {
  queueSync(state, truck.tenantId, [truck.plantId], truck.orderId);
}

export function notifyDispatched(state: MockState, a: Authed, now: number, truck: TruckRec, netKg: number): void {
  const { order, sub } = truckContext(state, truck);
  const data: DataOf<'truck.dispatched'> = {
    truckId: truck.id,
    orderId: order.id,
    vehicleNo: truck.vehicleNo,
    netKg,
    partyName: partyName(state, order),
    companyName: companyOf(state, sub.companyId)?.name ?? '?',
  };
  deliver(state, now, {
    tenantId: truck.tenantId,
    orderId: order.id,
    event: { kind: 'truck.dispatched', actorId: a.user.id, plantIds: [truck.plantId] },
    dataFor: () => data,
  });
}

/**
 * TON-57 Ruling 21: the supervisor marked the truck arrived. The plant head is alerted; owner and
 * city staff get a quiet row. `arrivedAt` is the arrival's business time.
 */
export function notifyArrived(state: MockState, a: Authed, now: number, truck: TruckRec, arrivedAt: string): void {
  const { order } = truckContext(state, truck);
  const data: DataOf<'truck.arrived'> = {
    truckId: truck.id,
    orderId: order.id,
    vehicleNo: truck.vehicleNo,
    plannedKg: truck.plan.reduce((s, p) => s + p.plannedKg, 0),
    partyName: partyName(state, order),
    plantName: state.plants.find((p) => p.id === truck.plantId)?.name ?? '?',
    arrivedAt,
  };
  deliver(state, now, {
    tenantId: truck.tenantId,
    orderId: order.id,
    event: { kind: 'truck.arrived', actorId: a.user.id, plantIds: [truck.plantId] },
    dataFor: () => data,
  });
}

/** TON-57: the weights are saved at the plant; the approvers (owner, city staff) are asked. */
export function notifyWeighed(state: MockState, a: Authed, now: number, truck: TruckRec, netKg: number): void {
  const { order } = truckContext(state, truck);
  const data: DataOf<'truck.weighed'> = {
    truckId: truck.id,
    orderId: order.id,
    vehicleNo: truck.vehicleNo,
    netKg,
    partyName: partyName(state, order),
    plantName: state.plants.find((p) => p.id === truck.plantId)?.name ?? '?',
  };
  deliver(state, now, {
    tenantId: truck.tenantId,
    orderId: order.id,
    event: { kind: 'truck.weighed', actorId: a.user.id, plantIds: [truck.plantId] },
    dataFor: () => data,
  });
}

export function notifyOverTolerance(state: MockState, a: Authed, now: number, sub: SubOrderRec, overKg: number): void {
  const order = state.orders.find((o) => o.id === sub.orderId);
  if (!order) return;
  const data: DataOf<'order.over_tolerance'> = {
    orderId: order.id,
    subOrderId: sub.id,
    subOrderNumber: subOrderNumber(order.number, sub.suffix),
    partyName: partyName(state, order),
    overKg,
  };
  deliver(state, now, {
    tenantId: order.tenantId,
    orderId: order.id,
    event: {
      kind: 'order.over_tolerance',
      actorId: a.user.id,
      plantIds: plantsOfCompanies(state, order.tenantId, [sub.companyId]),
      orderCreatorId: order.createdBy,
    },
    dataFor: () => data,
  });
}

export function notifyShortClosed(
  state: MockState,
  a: Authed,
  now: number,
  sub: SubOrderRec,
  closedKg: number,
  cancelledTruckPlantIds: readonly string[],
): void {
  const order = state.orders.find((o) => o.id === sub.orderId);
  if (!order) return;
  const data: DataOf<'order.short_closed'> = {
    orderId: order.id,
    subOrderNumber: subOrderNumber(order.number, sub.suffix),
    partyName: partyName(state, order),
    closedKg,
  };
  deliver(state, now, {
    tenantId: order.tenantId,
    orderId: order.id,
    event: {
      kind: 'order.short_closed',
      actorId: a.user.id,
      plantIds: plantsOfCompanies(state, order.tenantId, [sub.companyId]),
      orderCreatorId: order.createdBy,
    },
    dataFor: () => data,
  });
  if (cancelledTruckPlantIds.length > 0) queueSync(state, order.tenantId, cancelledTruckPlantIds, order.id);
}

export function notifyPayment(
  state: MockState,
  a: Authed,
  now: number,
  p: { brokerId: string; brokerName: string; paidRupees: number; dueRupees: number; mode: PaymentMode },
): void {
  const data: DataOf<'broker.payment_recorded'> = { ...p, actorName: a.user.name };
  deliver(state, now, {
    tenantId: a.user.tenantId,
    orderId: null,
    event: { kind: 'broker.payment_recorded', actorId: a.user.id, plantIds: [] },
    dataFor: () => data,
  });
}

export function notifyRejection(
  state: MockState,
  a: Authed,
  now: number,
  r: { rejectionId: string; truck: TruckRec; code: SyncRejectCode },
): void {
  const data: DataOf<'rejection.created'> = { rejectionId: r.rejectionId, vehicleNo: r.truck.vehicleNo, code: r.code };
  deliver(state, now, {
    tenantId: r.truck.tenantId,
    orderId: r.truck.orderId,
    event: { kind: 'rejection.created', actorId: a.user.id, plantIds: [r.truck.plantId] },
    dataFor: () => data,
  });
}

/**
 * The aged-orders digest (F5 Ruling 6): once per tenant per IST day, from 09:00 IST, when any
 * order is aged. B4 runs it as a 09:00 job; the mock runs it on the first request after.
 * Returns true when it changed state.
 */
export function runDailyDigest(state: MockState, tenantId: string, now: number): boolean {
  const tenant = tenantOf(state, tenantId);
  if (!tenant) return false;
  const istMinute = Math.floor(((now + IST_OFFSET_MS) % DAY) / MINUTE);
  const today = istDateOf(now);
  if (istMinute < DIGEST_FROM_IST_MINUTE || tenant.lastDigestDate === today) return false;
  tenant.lastDigestDate = today;
  const aged = agedOrders(state, tenant, now);
  if (aged.count === 0) return true;
  const data: DataOf<'orders.aged'> = { count: aged.count, days: tenant.settings.agedOrderDays, pendingKg: aged.pendingKg };
  deliver(state, now, {
    tenantId,
    orderId: null,
    event: { kind: 'orders.aged', actorId: 'system', plantIds: [] },
    dataFor: () => data,
  });
  return true;
}

function agedOrders(state: MockState, tenant: TenantRec, now: number): { count: number; pendingKg: number } {
  const owner = state.users.find((u) => u.tenantId === tenant.id && u.role === 'owner' && u.active);
  if (!owner) return { count: 0, pendingKg: 0 };
  const c = ctxFor({ state, now }, { user: owner, scope: plantScope(owner), tenant });
  let count = 0;
  let pendingKg = 0;
  for (const o of state.orders) {
    if (o.tenantId !== tenant.id) continue;
    const s = toSummary(c, o);
    if (!s.isAged) continue;
    count += 1;
    pendingKg += s.totals.pendingKg;
  }
  return { count, pendingKg };
}

/** Hard delete (§5.3): the order's notifications and unsent pushes go with it. */
export function purgeOrderNotifications(state: MockState, orderId: string): void {
  state.notifications = state.notifications.filter((n) => n.orderId !== orderId);
  state.pushOutbox = state.pushOutbox.filter((m) => m.orderId !== orderId);
}

// ── reading and delivering ─────────────────────────────────────────────────────────────────────

export function toNotification(n: NotificationRec): Notification {
  return { id: n.id, kind: n.kind, data: n.data, deepLink: n.deepLink, readAt: n.readAt, createdAt: n.createdAt } as Notification;
}

/** This person's notifications still kept, newest first. */
export function listFor(state: MockState, userId: string, now: number): NotificationRec[] {
  const from = now - NOTIFICATION_RETENTION_MS;
  return state.notifications
    .filter((n) => n.userId === userId && fromIso(n.createdAt) >= from)
    .sort((x, y) => (x.createdAt === y.createdAt ? y.id.localeCompare(x.id) : y.createdAt.localeCompare(x.createdAt)));
}

/**
 * Empties the outbox into one message per registered device. Called by the pipeline only after
 * the request committed (§5.7); a person with no device simply gets nothing pushed.
 */
export function drainOutbox(state: MockState): PushMessage[] {
  if (state.pushOutbox.length === 0) return [];
  const out: PushMessage[] = [];
  for (const m of state.pushOutbox) {
    const devices = state.devices.filter((d) => d.userId === m.userId);
    if (devices.length === 0) continue;
    let message: PushMessage['message'];
    if (m.message.type === 'sync') message = { type: 'sync', reason: 'tasks' };
    else {
      const id = m.message.notificationId;
      const n = state.notifications.find((x) => x.id === id);
      if (!n) continue;
      message = { type: 'alert', notification: toNotification(n) };
    }
    for (const d of devices) out.push({ token: d.token, message });
  }
  state.pushOutbox = [];
  return out;
}

/** Listeners for pushes; the mock's stand-in for Expo Push (F5 Ruling 1). */
export function createPushBus() {
  const listeners = new Set<(m: PushMessage) => void>();
  return {
    subscribe(fn: (m: PushMessage) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Delivers after the current request has answered, like a worker picking up the outbox. */
    publish(messages: readonly PushMessage[]): void {
      if (messages.length === 0) return;
      setTimeout(() => {
        for (const m of messages) for (const fn of listeners) fn(m);
      }, 0);
    },
  };
}
export type PushBus = ReturnType<typeof createPushBus>;

/**
 * Demo data (Reset demo data): replays the notify rules over the seeded orders, trucks and
 * payments at their own times, so the list looks lived-in and obeys every rule above. Rows older
 * than a day are read; nothing is pushed.
 */
export function seedDemoNotifications(state: MockState, now: number): void {
  const authedOf = (userId: string): Authed | null => {
    const user = state.users.find((u) => u.id === userId);
    const tenant = user && tenantOf(state, user.tenantId);
    return user && tenant ? { user, scope: plantScope(user), tenant } : null;
  };
  const order = (truck: TruckRec) => state.orders.find((o) => o.id === truck.orderId);
  // Approvals in the demo: city staff when the tenant has any active, so the owner is told.
  const approverOf = (o: OrderRec | undefined) =>
    state.users.find((u) => u.role === 'city_staff' && u.active && u.tenantId === o?.tenantId)?.id ?? o?.createdBy ?? '';
  const weigherAt = (truck: TruckRec) =>
    state.users.find((u) => u.role === 'supervisor' && u.active && u.plantIds.includes(truck.plantId))?.id ?? truck.assignedBy;
  const events: { at: number; run(at: number): void }[] = [];
  for (const order of state.orders) {
    const a = authedOf(order.createdBy);
    if (a) events.push({ at: fromIso(order.createdAt), run: (at) => notifyOrderCreated(state, a, at, order) });
  }
  for (const truck of state.trucks) {
    const by = authedOf(truck.assignedBy);
    if (by) events.push({ at: fromIso(truck.assignedAt), run: (at) => notifyTruckAssigned(state, by, at, truck) });
    const w = authedOf(weigherAt(truck));
    const net = truck.allocations.reduce((s, x) => s + x.netKg, 0);
    // TON-57 Ruling 21: a truck still at the plant's gate told the plant head and the office.
    if (truck.state === 'at_gate' && truck.atGateAt && w) {
      const arrivedAt = truck.atGateAt;
      events.push({ at: fromIso(arrivedAt), run: (at) => notifyArrived(state, w, at, truck, arrivedAt) });
    }
    // TON-57: a truck awaiting approval asked the office; a dispatched one was approved by the office.
    if (truck.state === 'weighed' && truck.weighedAt && w) {
      events.push({ at: fromIso(truck.weighedAt), run: (at) => notifyWeighed(state, w, at, truck, net) });
    }
    const approver = authedOf(approverOf(order(truck)));
    if (truck.state === 'dispatched' && truck.dispatchedAt && approver) {
      events.push({ at: fromIso(truck.dispatchedAt), run: (at) => notifyDispatched(state, approver, at, truck, net) });
    }
  }
  for (const sub of state.subOrders) {
    const a = sub.closedBy ? authedOf(sub.closedBy) : null;
    if (sub.closeKind !== 'short_close' || !sub.closedAt || !a) continue;
    const closedKg = state.orderLines.filter((l) => l.subOrderId === sub.id).reduce((s, l) => s + l.closedKg, 0);
    events.push({ at: fromIso(sub.closedAt), run: (at) => notifyShortClosed(state, a, at, sub, closedKg, []) });
  }
  for (const p of state.brokerLedger) {
    const a = authedOf(p.createdBy);
    const broker = state.parties.find((x) => x.id === p.brokerId);
    if (p.kind !== 'payment' || !a || !broker || !p.mode || !p.paidRupees) continue;
    const paid = p.paidRupees;
    const mode = p.mode;
    const due = state.brokerLedger.filter((r) => r.brokerId === p.brokerId).reduce((s, r) => s + r.amountRupees, 0);
    events.push({
      at: fromIso(p.createdAt),
      run: (at) => notifyPayment(state, a, at, { brokerId: broker.id, brokerName: broker.name, paidRupees: paid, dueRupees: due, mode }),
    });
  }
  for (const e of events.sort((x, y) => x.at - y.at)) e.run(e.at);
  const readAt = toIso(now);
  for (const n of state.notifications) if (now - fromIso(n.createdAt) > DAY) n.readAt = readAt;
  state.pushOutbox = [];
}

/** A signed-out (revoked) session stops pushing to its phone (F5 Ruling 7), even if the phone never said goodbye. */
export function dropDevice(state: MockState, userId: string, deviceId: string): void {
  state.devices = state.devices.filter((d) => !(d.userId === userId && d.deviceId === deviceId));
}
