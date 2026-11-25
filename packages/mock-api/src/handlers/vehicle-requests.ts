import { type VehicleRequest, isTerminal, pending, vehicleRequestBodySchema } from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { type IssueDetail, validationError } from '../errors.ts';
import { ctxFor, findOrder, visibleSubOrders } from '../order-views.ts';
import { route, type RouteDef } from '../router.ts';
import type { VehicleRequestRec } from '../store.ts';
import { authed, logActivity, newId } from '../views.ts';

export const vehicleRequestRoutes: RouteDef[] = [
  // Request vehicle (Ruling 9): records that staff asked the broker or customer for a truck. It
  // writes no truck, no ledger row and no notification, and the order's status does not change.
  route('POST', '/v1/orders/:id/vehicle-requests', {
    action: 'truck.assign',
    idempotent: true,
    transactional: true,
    body: vehicleRequestBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const c = ctxFor(ctx, a);
      const order = findOrder(c, ctx.params.id);

      const subs = visibleSubOrders(c, order);
      const subById = new Map(subs.map((s) => [s.id, s]));
      const lineById = new Map(subs.flatMap((s) => c.math.linesOf(s.id)).map((l) => [l.id, l]));
      const issues: IssueDetail[] = [];
      const seen = new Set<string>();
      const lines = body.lines.flatMap((l, i) => {
        const line = lineById.get(l.orderLineId);
        if (!line || seen.has(l.orderLineId)) {
          const message = line ? 'This line is already in the request' : 'This line is not on the order';
          issues.push({ path: ['lines', i, 'orderLineId'], message });
          return [];
        }
        seen.add(l.orderLineId);
        const sub = subById.get(line.subOrderId);
        const open = sub !== undefined && !isTerminal(c.math.subOrderStatus(sub));
        if (!open || l.kg > pending(c.math.lineQty(line))) {
          issues.push({ path: ['lines', i, 'kg'], message: 'More than is pending on this line' });
          return [];
        }
        return [{ orderLineId: line.id, subOrderId: line.subOrderId, kg: l.kg }];
      });
      if (body.totalKg !== body.lines.reduce((sum, l) => sum + l.kg, 0)) {
        issues.push({ path: ['totalKg'], message: 'Total does not match the lines' });
      }
      const party =
        body.partyId === order.customerId || body.partyId === order.brokerId
          ? state.parties.find((p) => p.id === body.partyId && p.tenantId === a.user.tenantId)
          : undefined;
      if (!party) issues.push({ path: ['partyId'], message: "Choose the order's customer or broker" });
      if (issues.length > 0 || !party) throw validationError(issues);

      const rec: VehicleRequestRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        orderId: order.id,
        partyId: party.id,
        partyName: party.name,
        contactName: body.contactName,
        number: body.number,
        channel: body.channel,
        lines,
        totalKg: body.totalKg,
        requestedAt: toIso(now),
        requestedBy: a.user.id,
      };
      state.vehicleRequests.push(rec);
      logActivity(state, a, now, {
        entityType: 'order',
        entityId: order.id,
        action: 'order.vehicle_requested',
        meta: { contactName: rec.contactName, channel: rec.channel, totalKg: rec.totalKg, partyName: rec.partyName },
      });
      const request: VehicleRequest = {
        id: rec.id,
        partyId: rec.partyId,
        partyName: rec.partyName,
        contactName: rec.contactName,
        number: rec.number,
        channel: rec.channel,
        lines: rec.lines.map((l) => ({ ...l })),
        totalKg: rec.totalKg,
        requestedAt: rec.requestedAt,
        requestedBy: { id: a.user.id, name: a.user.name },
      };
      return { status: 201, body: { request } };
    },
  }),
];
