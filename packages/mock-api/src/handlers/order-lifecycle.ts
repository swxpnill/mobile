import {
  type ActivityEntry,
  type EditLineDesired,
  type EditLineExisting,
  assignable,
  deleteOrderBodySchema,
  isTerminal,
  lineRate,
  moveQuantityBodySchema,
  planOrderEdit,
  reopenBodySchema,
  shortCloseBodySchema,
  subOrderSuffix,
  updateOrderBodySchema,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, notFound, stale, validationError } from '../errors.ts';
import { type OrderCtx, findOrder, orderCtx, toOrder } from '../order-views.ts';
import { type OrderMath, isOpenTruck, orderMath } from '../orders-math.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, OrderLineRec, OrderRec, SubOrderRec } from '../store.ts';
import { type Authed, authed, logActivity, newId } from '../views.ts';
import { newLineRec, newSubOrderRec, validateOrderRefs } from './orders.ts';

const keyOf = (productId: string, length: { value: number; unit: string }) =>
  `${productId}|${length.value}${length.unit}`;

function ctxFor(ctx: { state: MockState; now: number }, a: Authed): OrderCtx {
  return orderCtx(ctx.state, orderMath(ctx.state), a, ctx.now);
}

/** Sub-order by id in tenant and scope; 404 otherwise. Returns it with its order. */
function findSubOrder(c: OrderCtx, id: string | undefined): { sub: SubOrderRec; order: OrderRec } {
  const sub = c.state.subOrders.find((s) => s.id === id && s.tenantId === c.a.user.tenantId);
  if (!sub || !c.visibleCompanyIds.has(sub.companyId)) throw notFound();
  const order = c.state.orders.find((o) => o.id === sub.orderId);
  if (!order) throw notFound();
  return { sub, order };
}

/** The next unused suffix; a removed "B" is never handed out again (§5.3 numbering). */
function nextSuffix(order: OrderRec): string {
  const s = subOrderSuffix(order.suffixesUsed);
  order.suffixesUsed += 1;
  return s;
}

function bump(rec: { version: number; updatedAt: string }, at: string): void {
  rec.version += 1;
  rec.updatedAt = at;
}

function cancelTrucks(math: OrderMath, sub: SubOrderRec, at: string, by: string, reason: string): number {
  let n = 0;
  for (const t of math.trucksOf(sub.id)) {
    if (!isOpenTruck(t)) continue;
    t.state = 'cancelled';
    t.cancelledAt = at;
    t.cancelledBy = by;
    t.cancelReason = reason;
    bump(t, at);
    n += 1;
  }
  return n;
}

function removeLines(state: MockState, ids: ReadonlySet<string>): void {
  state.orderLines = state.orderLines.filter((l) => !ids.has(l.id));
}

export const orderLifecycleRoutes: RouteDef[] = [
  route('PATCH', '/v1/orders/:id', {
    action: 'order.edit',
    transactional: true,
    body: updateOrderBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const order = findOrder(c, ctx.params.id);
      if (body.version !== order.version) throw stale();
      validateOrderRefs(state, a, body);

      const subs = c.math.subOrdersOf(order.id);
      const subById = new Map(subs.map((s) => [s.id, s]));
      const existingLines = subs.flatMap((s) => c.math.linesOf(s.id).map((l) => ({ l, s })));
      const lineById = new Map(existingLines.map((x) => [x.l.id, x]));

      // Match each body sub-order to an existing one (by id, else by company) or mark it new.
      const targets = body.subOrders.map((bs, si) => {
        const s = (bs.id !== undefined ? subById.get(bs.id) : undefined) ?? subs.find((x) => x.companyId === bs.companyId);
        if (s && s.companyId !== bs.companyId) {
          throw validationError([{ path: ['subOrders', si, 'companyId'], message: "A sub-order's company can't change" }]);
        }
        return s;
      });

      const existing: EditLineExisting[] = existingLines.map(({ l, s }) => {
        const q = c.math.lineQty(l);
        return {
          lineId: l.id,
          productKey: keyOf(l.productId, l.length),
          orderedKg: l.orderedKg,
          rate: l.rate,
          overpricePerMt: l.overpricePerMt,
          dispatchedKg: q.dispatchedKg,
          reservedKg: q.reservedKg,
          terminal: isTerminal(c.math.subOrderStatus(s)),
        };
      });
      const desired: (EditLineDesired & { si: number; li: number })[] = [];
      body.subOrders.forEach((bs, si) => {
        const s = targets[si];
        const terminal = s ? isTerminal(c.math.subOrderStatus(s)) : false;
        bs.lines.forEach((bl, li) => {
          const prev = bl.id !== undefined ? lineById.get(bl.id) : undefined;
          if (bl.id !== undefined && prev && prev.s.id !== s?.id) {
            throw validationError([
              { path: ['subOrders', si, 'lines', li, 'id'], message: 'A line cannot move to another company; use Move quantity' },
            ]);
          }
          const product = state.products.find((p) => p.id === bl.productId);
          const conversion = prev ? prev.l.conversionSnapshot : (product?.conversionPerMt ?? 0);
          const { rate } = lineRate({
            method: body.pricingMethod,
            basicRate: body.basicRate,
            conversionPerMt: conversion,
            typedRate: bl.typedRate,
          });
          desired.push({
            ...(bl.id !== undefined ? { lineId: bl.id } : {}),
            productKey: keyOf(bl.productId, bl.length),
            orderedKg: bl.orderedKg,
            rate,
            overpricePerMt: bl.overpricePerMt,
            terminal,
            si,
            li,
          });
        });
      });

      // A line still planned on a truck at the plant cannot disappear from under that truck.
      const keptIds = new Set(desired.flatMap((d) => (d.lineId !== undefined ? [d.lineId] : [])));
      const planned = existing.find((e) => !keptIds.has(e.lineId) && e.reservedKg > 0 && e.dispatchedKg === 0);
      if (planned) throw new ApiError(409, 'OPEN_TRUCKS', { lineId: planned.lineId });

      const plan = planOrderEdit({ role: a.user.role, existing, desired });
      const firstError = plan.errors[0];
      if (firstError) {
        throw new ApiError(409, firstError.code, firstError.lineId !== undefined ? { lineId: firstError.lineId } : undefined);
      }

      const at = toIso(now);
      Object.assign(order, {
        type: body.type,
        customerId: body.customerId,
        brokerId: body.brokerId,
        commissionPerMtSnapshot: body.brokerId !== null ? body.commissionPerMt : null,
        billToId: body.billToId,
        shipToId: body.shipToId,
        pricingMethod: body.pricingMethod,
        basicRate: body.pricingMethod === 'basic_conversion' ? body.basicRate : null,
        notify: { ...body.notify },
      });
      bump(order, at);

      const keptLines = new Set<string>();
      const keptSubs = new Set<string>();
      body.subOrders.forEach((bs, si) => {
        let s = targets[si];
        if (!s) {
          s = newSubOrderRec(order, bs.companyId, nextSuffix(order), at);
          state.subOrders.push(s);
        }
        keptSubs.add(s.id);
        for (const bl of bs.lines) {
          const prev = bl.id !== undefined ? lineById.get(bl.id)?.l : undefined;
          if (!prev) {
            state.orderLines.push(newLineRec(state, body, s, bl, at));
            continue;
          }
          keptLines.add(prev.id);
          const { rate, rateEdited } = lineRate({
            method: body.pricingMethod,
            basicRate: body.basicRate,
            conversionPerMt: prev.conversionSnapshot,
            typedRate: bl.typedRate,
          });
          const next = {
            productId: bl.productId,
            length: { ...bl.length },
            orderedKg: bl.orderedKg,
            rate,
            rateEdited,
            overpricePerMt: bl.overpricePerMt,
            basicRateSnapshot: body.pricingMethod === 'basic_conversion' ? body.basicRate : null,
          };
          const changed = (Object.keys(next) as (keyof typeof next)[]).some(
            (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]),
          );
          if (changed) {
            Object.assign(prev, next);
            bump(prev, at);
          }
        }
      });
      const removed = new Set(existingLines.filter(({ l }) => !keptLines.has(l.id)).map(({ l }) => l.id));
      removeLines(state, removed);
      // A sub-order left out of the body (all its lines removable) goes; trucks never point at it.
      state.subOrders = state.subOrders.filter((s) => s.orderId !== order.id || keptSubs.has(s.id));

      logActivity(state, a, now, { entityType: 'order', entityId: order.id, action: 'order.edited' });
      const out = toOrder(ctxFor(ctx, a), order);
      return { body: plan.warnings.length > 0 ? { ...out, warnings: plan.warnings } : out };
    },
  }),

  route('POST', '/v1/sub-orders/:id/short-close', {
    action: 'order.shortClose',
    transactional: true,
    body: shortCloseBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const { sub, order } = findSubOrder(c, ctx.params.id);
      if (body.version !== sub.version) throw stale();
      // Completed (nothing pending) is closed too: short closing it would rewrite history.
      if (sub.closeKind !== null || isTerminal(c.math.subOrderStatus(sub))) throw new ApiError(409, 'ALREADY_CLOSED');
      const open = c.math.openTrucksOf(sub.id);
      if (open.length > 0 && !body.cancelOpenTrucks) throw new ApiError(409, 'OPEN_TRUCKS', { trucks: open });

      const at = toIso(now);
      const cancelled = cancelTrucks(c.math, sub, at, a.user.id, 'Order short closed');
      // Pending after the cancellations (reserved no longer matters; dispatched is unchanged).
      const lines = c.math.linesOf(sub.id);
      let dispatched = 0;
      for (const l of lines) {
        const q = c.math.lineQty(l);
        dispatched += q.dispatchedKg;
        const closed = Math.max(0, q.orderedKg - q.dispatchedKg);
        if (closed !== l.closedKg) {
          l.closedKg = closed;
          bump(l, at);
        }
      }
      Object.assign(sub, {
        closeKind: dispatched === 0 ? 'cancel' : 'short_close',
        closeReason: body.reason,
        closeNote: body.note === '' ? null : body.note,
        closedAt: at,
        closedBy: a.user.id,
      });
      bump(sub, at);
      bump(order, at);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: dispatched === 0 ? 'order.sub_cancelled' : 'order.short_closed',
        meta: { subOrderId: sub.id, suffix: sub.suffix, reason: body.reason, trucksCancelled: cancelled },
      });
      return { body: toOrder(ctxFor(ctx, a), order) };
    },
  }),

  route('POST', '/v1/sub-orders/:id/reopen', {
    action: 'order.reopen',
    transactional: true,
    body: reopenBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const { sub, order } = findSubOrder(c, ctx.params.id);
      if (body.version !== sub.version) throw stale();
      if (sub.closeKind === null) throw new ApiError(409, 'NOT_CLOSED');
      const at = toIso(now);
      for (const l of c.math.linesOf(sub.id)) {
        if (l.closedKg !== 0) {
          l.closedKg = 0;
          bump(l, at);
        }
      }
      Object.assign(sub, { closeKind: null, closeReason: null, closeNote: null, closedAt: null, closedBy: null });
      bump(sub, at);
      bump(order, at);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: 'order.reopened',
        meta: { subOrderId: sub.id, suffix: sub.suffix },
      });
      return { body: toOrder(ctxFor(ctx, a), order) };
    },
  }),

  route('POST', '/v1/orders/:id/move-quantity', {
    action: 'order.edit',
    transactional: true,
    body: moveQuantityBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const order = findOrder(c, ctx.params.id);
      if (body.version !== order.version) throw stale();
      const subs = c.math.subOrdersOf(order.id);
      const fromSub = subs.find((s) => c.math.linesOf(s.id).some((l) => l.id === body.fromLineId));
      const from = fromSub ? c.math.linesOf(fromSub.id).find((l) => l.id === body.fromLineId) : undefined;
      if (!fromSub || !from) throw validationError([{ path: ['fromLineId'], message: 'This line is not on the order' }]);
      if (isTerminal(c.math.subOrderStatus(fromSub))) throw new ApiError(409, 'ORDER_LOCKED', { subOrderId: fromSub.id });
      if (body.toCompanyId === fromSub.companyId) {
        throw validationError([{ path: ['toCompanyId'], message: 'Choose another company' }]);
      }
      const company = state.companies.find((x) => x.id === body.toCompanyId && x.tenantId === a.user.tenantId);
      if (!company) throw validationError([{ path: ['toCompanyId'], message: 'Unknown company' }]);
      if (!company.active) throw new ApiError(409, 'COMPANY_INACTIVE');
      const product = state.products.find((p) => p.id === from.productId);
      if (!product?.companyIds.includes(company.id)) throw new ApiError(409, 'PRODUCT_NOT_FOR_COMPANY');
      const availableKg = Math.max(0, assignable(c.math.lineQty(from)));
      if (body.kg > availableKg) throw new ApiError(409, 'MOVE_EXCEEDS_AVAILABLE', { availableKg });

      const at = toIso(now);
      let toSub = subs.find((s) => s.companyId === company.id);
      if (toSub && isTerminal(c.math.subOrderStatus(toSub))) throw new ApiError(409, 'ORDER_LOCKED', { subOrderId: toSub.id });
      if (!toSub) {
        toSub = newSubOrderRec(order, company.id, nextSuffix(order), at);
        state.subOrders.push(toSub);
      }
      const same = (l: OrderLineRec) =>
        l.productId === from.productId &&
        keyOf(l.productId, l.length) === keyOf(from.productId, from.length) &&
        l.rate === from.rate &&
        l.overpricePerMt === from.overpricePerMt;
      const target = state.orderLines.find((l) => l.subOrderId === toSub.id && same(l));
      if (target) {
        target.orderedKg += body.kg;
        bump(target, at);
      } else {
        state.orderLines.push({ ...from, id: newId(), subOrderId: toSub.id, orderedKg: body.kg, closedKg: 0, version: 1, createdAt: at, updatedAt: at });
      }
      from.orderedKg -= body.kg;
      bump(from, at);
      if (from.orderedKg === 0 && c.math.lineQty(from).dispatchedKg === 0) removeLines(state, new Set([from.id]));
      if (!state.orderLines.some((l) => l.subOrderId === fromSub.id)) {
        state.subOrders = state.subOrders.filter((s) => s.id !== fromSub.id);
      }
      bump(order, at);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: 'order.quantity_moved',
        meta: {
          fromLineId: from.id,
          fromSubOrderId: fromSub.id,
          toSubOrderId: toSub.id,
          fromSuffix: fromSub.suffix,
          toSuffix: toSub.suffix,
          kg: body.kg,
        },
      });
      return { body: toOrder(ctxFor(ctx, a), order) };
    },
  }),

  route('GET', '/v1/orders/:id/delete-preview', {
    action: 'order.hardDelete',
    async handler(ctx) {
      const a = authed(ctx);
      const c = ctxFor(ctx, a);
      const order = findOrder(c, ctx.params.id);
      return { body: deletePreview(c, order) };
    },
  }),

  route('DELETE', '/v1/orders/:id', {
    action: 'order.hardDelete',
    transactional: true,
    body: deleteOrderBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state } = ctx;
      const c = ctxFor(ctx, a);
      const order = findOrder(c, ctx.params.id);
      if (body.confirmNumber.trim().toUpperCase() !== order.number.toUpperCase()) {
        throw new ApiError(409, 'CONFIRMATION_MISMATCH');
      }
      const preview = deletePreview(c, order);
      if (preview.dispatchedKg > 0 && !a.tenant.settings.allowHardDeleteAfterDispatch) {
        throw new ApiError(409, 'HARD_DELETE_DISABLED');
      }
      // Fixed order, children first (B2 does the same inside one transaction with an order lock).
      const subIds = new Set(c.math.subOrdersOf(order.id).map((s) => s.id));
      const truckIds = new Set(state.trucks.filter((t) => subIds.has(t.subOrderId)).map((t) => t.id));
      state.weighments = state.weighments.filter((w) => !truckIds.has(w.truckId));
      state.rejections = state.rejections.filter((r) => !truckIds.has(r.truckId));
      state.brokerLedger = state.brokerLedger.filter((r) => !truckIds.has(r.truckId));
      for (const [eventId, e] of Object.entries(state.appliedEvents)) {
        if (truckIds.has(e.truckId)) delete state.appliedEvents[eventId];
      }
      state.trucks = state.trucks.filter((t) => !subIds.has(t.subOrderId));
      state.orderLines = state.orderLines.filter((l) => !subIds.has(l.subOrderId));
      state.subOrders = state.subOrders.filter((s) => !subIds.has(s.id));
      state.activity = state.activity.filter((e) => !(e.entityType === 'order' && e.entityId === order.id));
      state.orders = state.orders.filter((o) => o.id !== order.id);
      return { status: 204 };
    },
  }),

  route('GET', '/v1/orders/:id/activity', {
    action: 'order.view',
    async handler(ctx) {
      const a = authed(ctx);
      const c = ctxFor(ctx, a);
      const order = findOrder(c, ctx.params.id);
      // A plant head sees only their companies' sub-orders, so history about the others is left out too.
      const hidden = new Set(
        ctx.state.subOrders.filter((s) => s.orderId === order.id && !c.visibleCompanyIds.has(s.companyId)).map((s) => s.id),
      );
      const mentionsHidden = (meta: Record<string, unknown> | undefined) =>
        meta !== undefined && ['subOrderId', 'fromSubOrderId', 'toSubOrderId'].some((k) => hidden.has(meta[k] as string));
      const entries: ActivityEntry[] = ctx.state.activity
        .filter((e) => e.entityType === 'order' && e.entityId === order.id && !mentionsHidden(e.meta))
        .map((e) => ({
          id: e.id,
          action: e.action,
          actorName: c.userNameById.get(e.actorId) ?? '',
          at: e.at,
          ...(e.meta ? { meta: { ...e.meta } } : {}),
        }))
        .reverse();
      return { body: entries };
    },
  }),
];

function deletePreview(c: OrderCtx, order: OrderRec) {
  const subs = c.math.subOrdersOf(order.id);
  const trucks = subs.flatMap((s) => c.math.trucksOf(s.id));
  return {
    subOrders: subs.length,
    lines: subs.reduce((n, s) => n + c.math.linesOf(s.id).length, 0),
    trucks: trucks.length,
    dispatchedKg: trucks
      .filter((t) => t.state === 'dispatched')
      .reduce((n, t) => n + t.allocations.reduce((m, x) => m + x.netKg, 0), 0),
    weighments: trucks.reduce((n, t) => n + (t.tareKg !== null ? 1 : 0) + (t.state === 'dispatched' ? 1 : 0), 0),
  };
}
