import { type Order, type VehicleRequest, type VehicleRequestBody } from '@tonnage/shared';
import { splitProduct } from './RequestVehicleSheet';

export type QueuedRequest = VehicleRequestBody & { queuedAt: string; key: string };
/** A request as the note shows it; `waiting` while it is still only on this phone. */
export type NoteRequest = { request: VehicleRequest; waiting: boolean };

export const channelWord = (c: VehicleRequest['channel']): string => (c === 'whatsapp' ? 'WhatsApp' : 'Call');

/** The queued request as the order will show it once recorded (the server's row replaces it). */
function fromQueued(order: Order, q: QueuedRequest): VehicleRequest {
  const party = [order.customer, order.broker].find((p) => p?.id === q.partyId);
  const subOf = new Map(order.subOrders.flatMap((s) => s.lines.map((l) => [l.id, s.id] as const)));
  return {
    id: `queued-${q.key}`,
    partyId: q.partyId,
    partyName: party?.name ?? q.contactName,
    contactName: q.contactName,
    number: q.number,
    channel: q.channel,
    lines: q.lines.map((l) => ({ orderLineId: l.orderLineId, subOrderId: subOf.get(l.orderLineId) ?? '', kg: l.kg })),
    totalKg: q.totalKg,
    requestedAt: q.queuedAt,
    requestedBy: order.createdBy,
  };
}

/** Open requests (server's and still-queued ones), newest first. */
export function noteRequests(order: Order, queued: QueuedRequest[]): NoteRequest[] {
  const waitingIds = new Set(queued.map((q) => `queued-${q.key}`));
  const rows: NoteRequest[] = order.vehicleRequests.map((request) => ({ request, waiting: waitingIds.has(request.id) }));
  const have = new Set(rows.map((r) => r.request.id));
  for (const q of queued) {
    if (!have.has(`queued-${q.key}`)) rows.push({ request: fromQueued(order, q), waiting: true });
  }
  return rows.sort((a, b) => Date.parse(b.request.requestedAt) - Date.parse(a.request.requestedAt));
}

/** Distinct sizes of a request's lines: "25 mm" or "12 mm, 16 mm". */
export function requestSizes(order: Order, r: VehicleRequest): string {
  const names = new Map(order.subOrders.flatMap((s) => s.lines.map((l) => [l.id, l.productName] as const)));
  const sizes = r.lines.map((l) => splitProduct(names.get(l.orderLineId) ?? '').size).filter((s) => s !== '');
  return [...new Set(sizes)].join(', ');
}
