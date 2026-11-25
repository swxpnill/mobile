import { normalizeIndianMobile } from '../mobile.ts';
import type { Party } from '../schemas/masters.ts';
import type { PartyRef } from '../schemas/orders.ts';
import { toDisplayQty, unitLabel, type UnitBasis } from '../units.ts';

export type VehicleRequestRecipient = { partyId: string; contactId: string; numberId: string };

type NumberLike = { number: string; whatsapp: boolean };

/** WhatsApp only when flagged and a real Indian mobile: a landline is "call only" (Ruling 6). */
export function isWhatsAppNumber(n: NumberLike): boolean {
  return n.whatsapp && normalizeIndianMobile(n.number) !== null;
}

function firstNumber(party: Party | undefined, accept: (n: NumberLike) => boolean): VehicleRequestRecipient | null {
  if (!party) return null;
  for (const c of party.contacts) {
    for (const n of c.numbers) {
      if (accept(n)) return { partyId: party.id, contactId: c.id, numberId: n.id };
    }
  }
  return null;
}

/** Broker's first WhatsApp number, else the customer's, else the first number of either. */
export function defaultRecipient(
  order: { broker: PartyRef | null; customer: PartyRef | null },
  parties: Record<string, Party>,
): VehicleRequestRecipient | null {
  const broker = order.broker ? parties[order.broker.id] : undefined;
  const customer = order.customer ? parties[order.customer.id] : undefined;
  return (
    firstNumber(broker, isWhatsAppNumber) ??
    firstNumber(customer, isWhatsAppNumber) ??
    firstNumber(broker, () => true) ??
    firstNumber(customer, () => true)
  );
}

/** An integer in [0, pendingKg]; non-finite input is 0. */
export function clampLineKg(kg: number, pendingKg: number): number {
  if (!Number.isFinite(kg)) return 0;
  return Math.min(Math.max(Math.trunc(kg), 0), Math.max(Math.trunc(pendingKg), 0));
}

export type RequestMessageInput = {
  contactFirstName: string;
  orderNo: string;
  /** Already composed by the caller: name + ", " + city. */
  party: string;
  lines: { product: string; size: string; length: string; kg: number; company: string; plant: string | null }[];
  senderFirstName: string;
  basis: UnitBasis;
};

export function buildRequestMessage(input: RequestMessageInput): string {
  const { basis } = input;
  const qty = (kg: number) => `${toDisplayQty(kg, basis)} ${unitLabel(basis)}`;
  const lines = input.lines.map(
    (l) =>
      `• ${l.product} ${l.size} · ${l.length} — ${qty(l.kg)} (${l.company}${l.plant ? `, ${l.plant}` : ''})`,
  );
  const total = input.lines.reduce((sum, l) => sum + l.kg, 0);
  return [
    `Namaste ${input.contactFirstName} ji, please arrange a vehicle for order ${input.orderNo} (${input.party}):`,
    ...lines,
    `Total ${qty(total)}. Please share vehicle number and driver phone.`,
    `– ${input.senderFirstName}, Tonnage`,
  ].join('\n');
}

export type OpenCheckContext = {
  trucks: { subOrderIds: string[]; assignedAt: string }[];
  subOrderClosed: (subOrderId: string) => boolean;
  linePendingKg: (orderLineId: string) => number;
};

/**
 * Open until a truck is assigned after the request to one of its sub-orders; a short close or
 * nothing left pending on its lines also ends it (Ruling 4).
 */
export function isRequestOpen(
  req: { requestedAt: string; lines: { orderLineId: string; subOrderId: string; kg: number }[] },
  ctx: OpenCheckContext,
): boolean {
  const requestedAt = Date.parse(req.requestedAt);
  const subOrderIds = new Set(req.lines.map((l) => l.subOrderId));
  const truckCame = ctx.trucks.some(
    (t) => Date.parse(t.assignedAt) > requestedAt && t.subOrderIds.some((id) => subOrderIds.has(id)),
  );
  if (truckCame) return false;
  return req.lines.some((l) => !ctx.subOrderClosed(l.subOrderId) && ctx.linePendingKg(l.orderLineId) > 0);
}
