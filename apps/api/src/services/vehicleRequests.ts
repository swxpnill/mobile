import { type VehicleRequest, type VehicleRequestBody, isTerminal, pending } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../db/client.ts';
import { parties, vehicleRequestLines, vehicleRequests } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { graphMath } from '../views/orderGraph.ts';
import { visibleSubOrders } from '../views/orders.ts';
import { logActivity } from './activity.ts';
import type { OrderWriteCtx } from './orderEdit.ts';
import { findOrder } from './orderGraph.ts';
import { lockOrderTree } from './orderTree.ts';

// Ported from packages/mock-api/src/handlers/vehicle-requests.ts (Request vehicle, Ruling 9): records
// that staff asked the broker or customer for a truck. No truck, no ledger row, no notification,
// and the order's status does not change.

interface Issue {
  path: (string | number)[];
  message: string;
}

/** `POST /v1/orders/:id/vehicle-requests`: 201 `{ request }`. */
export async function createVehicleRequest(
  tx: Tx,
  c: OrderWriteCtx,
  orderId: string | undefined,
  body: VehicleRequestBody,
): Promise<{ request: VehicleRequest }> {
  const { graph: seen, ctx } = await findOrder(tx, c.user, c.scope, c.now, orderId);
  // Pending is read under the order lock, so a dispatch or close cannot slip in between.
  const g = await lockOrderTree(tx, seen.order.id, { mode: 'no key update', trucks: true });
  if (!g) throw new AppError(404, 'NOT_FOUND');
  const m = graphMath(g);
  const subs = visibleSubOrders(ctx, g);
  const subById = new Map(subs.map((s) => [s.sub.id, s]));
  const lineById = new Map(subs.flatMap((s) => s.lines).map((l) => [l.id, l]));

  const issues: Issue[] = [];
  const seenLines = new Set<string>();
  const lines = body.lines.flatMap((l, i) => {
    const line = lineById.get(l.orderLineId);
    if (!line || seenLines.has(l.orderLineId)) {
      const message = line ? 'This line is already in the request' : 'This line is not on the order';
      issues.push({ path: ['lines', i, 'orderLineId'], message });
      return [];
    }
    seenLines.add(l.orderLineId);
    const sub = subById.get(line.subOrderId);
    const open = sub !== undefined && !isTerminal(m.subOrderStatus(sub));
    if (!open || l.kg > pending(m.lineQty(line))) {
      issues.push({ path: ['lines', i, 'kg'], message: 'More than is pending on this line' });
      return [];
    }
    return [{ orderLineId: line.id, subOrderId: line.subOrderId, kg: l.kg }];
  });
  if (body.totalKg !== body.lines.reduce((sum, l) => sum + l.kg, 0)) {
    issues.push({ path: ['totalKg'], message: 'Total does not match the lines' });
  }
  const onOrder = body.partyId === g.order.customerId || body.partyId === g.order.brokerId;
  const [party] = onOrder ? await tx.select({ id: parties.id, name: parties.name }).from(parties).where(eq(parties.id, body.partyId)) : [];
  if (!party) issues.push({ path: ['partyId'], message: "Choose the order's customer or broker" });
  if (issues.length > 0 || !party) throw new AppError(422, 'VALIDATION', issues);

  const id = uuidv7();
  const at = new Date(c.now);
  await tx.insert(vehicleRequests).values({
    id,
    tenantId: c.user.tenantId,
    orderId: g.order.id,
    partyId: party.id,
    partyName: party.name,
    contactName: body.contactName,
    number: body.number,
    channel: body.channel,
    totalKg: body.totalKg,
    requestedAt: at,
    requestedBy: c.user.id,
    createdAt: at,
    updatedAt: at,
  });
  await tx
    .insert(vehicleRequestLines)
    .values(lines.map((l, position) => ({ tenantId: c.user.tenantId, requestId: id, orderLineId: l.orderLineId, subOrderId: l.subOrderId, position, kg: l.kg })));
  await logActivity(tx, c.user, c.now, {
    entityType: 'order',
    entityId: g.order.id,
    orderId: g.order.id,
    action: 'order.vehicle_requested',
    meta: { contactName: body.contactName, channel: body.channel, totalKg: body.totalKg, partyName: party.name },
  });
  return {
    request: {
      id,
      partyId: party.id,
      partyName: party.name,
      contactName: body.contactName,
      number: body.number,
      channel: body.channel,
      lines,
      totalKg: body.totalKg,
      requestedAt: at.toISOString(),
      requestedBy: { id: c.user.id, name: c.user.name },
    },
  };
}
