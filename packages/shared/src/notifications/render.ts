import { formatRupees } from '../format.ts';
import type { SyncRejectCode } from '../schemas/trucks.ts';
import { type UnitBasis, toDisplayQty } from '../units.ts';
import type { NotificationContent, NotificationKind } from './kinds.ts';

/** Why the server refused a weight from a phone, in plain words (Needs attention, notifications). */
export const SYNC_REJECT_REASON: Record<SyncRejectCode, string> = {
  TRUCK_CANCELLED: 'Truck was cancelled before this weight reached the server',
  INVALID_STATE: 'The truck was not at this step when the weight arrived',
  ALLOC_MISMATCH: 'The split over the order lines does not add up to the net',
  TARE_CONFLICT: 'A different tare was already saved for this truck',
  INVALID_WEIGHT: 'The gross is not more than the tare',
  LINE_REMOVED: 'An order line on this truck was removed',
  TARE_REQUIRED: 'The gross arrived before any tare',
  ALREADY_DISPATCHED: 'The truck was already dispatched',
  PLANT_SCOPE: 'The sender no longer has access to this plant',
};

const IST_OFFSET_MS = 330 * 60_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** `HH:mm` in IST. */
export function istTime(at: string): string {
  const d = new Date(Date.parse(at) + IST_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;
const due = (rupees: number) =>
  rupees > 0 ? `${formatRupees(rupees)} still due` : rupees < 0 ? `Advance ${formatRupees(-rupees)}` : 'Nothing due';

/** Title and body as on canvas board 37, in the viewer's unit basis (F5 plan Ruling 3). */
export function renderNotification(
  n: NotificationContent & { createdAt: string },
  basis: UnitBasis,
): { title: string; body: string } {
  const qty = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  switch (n.kind) {
    case 'truck.dispatched': {
      const d = n.data;
      // Board 37 names the company by its short name ("Aarav"), as Home's unit split does.
      return { title: `${d.vehicleNo} dispatched`, body: `${qty(d.netKg)} to ${d.partyName} · ${firstName(d.companyName)} · ${istTime(n.createdAt)}` };
    }
    case 'order.over_tolerance': {
      const d = n.data;
      return { title: `Over-loaded by ${qty(d.overKg)}`, body: `${d.subOrderNumber} · ${d.partyName} · allowed` };
    }
    case 'order.created': {
      const d = n.data;
      return {
        title: `New order ${d.orderNumber}`,
        body: `${firstName(d.actorName)} · ${d.partyName} · ${qty(d.orderedKg)} · ${d.companyCodes.join(' + ')}`,
      };
    }
    case 'orders.aged': {
      const d = n.data;
      return {
        title: `${d.count} ${d.count === 1 ? 'order' : 'orders'} older than ${d.days} days`,
        body: `${qty(d.pendingKg)} still pending · tap to review`,
      };
    }
    case 'broker.payment_recorded': {
      const d = n.data;
      return {
        title: `${formatRupees(d.paidRupees)} paid to ${d.brokerName}`,
        body: `${d.mode.toUpperCase()} · recorded by ${firstName(d.actorName)} · ${due(d.dueRupees)}`,
      };
    }
    case 'order.short_closed': {
      const d = n.data;
      return { title: `${d.subOrderNumber} short closed`, body: `${qty(d.closedKg)} stopped · ${d.partyName}` };
    }
    case 'truck.assigned': {
      const d = n.data;
      return { title: `${d.vehicleNo} assigned`, body: `${qty(d.plannedKg)} planned · ${d.partyName} · ${d.plantName}` };
    }
    case 'rejection.created': {
      const d = n.data;
      return { title: `Weight not accepted · ${d.vehicleNo}`, body: `${SYNC_REJECT_REASON[d.code]} · Needs attention` };
    }
  }
}

export type NotificationTone = 'bl' | 'vi' | 'gr' | 'am' | 'rd';
const TILES: Record<NotificationKind, { icon: string; tone: NotificationTone }> = {
  'truck.dispatched': { icon: 'check', tone: 'gr' },
  'order.over_tolerance': { icon: 'scales', tone: 'am' },
  'order.created': { icon: 'orders', tone: 'bl' },
  'orders.aged': { icon: 'clock', tone: 'rd' },
  'broker.payment_recorded': { icon: 'wallet', tone: 'vi' },
  'order.short_closed': { icon: 'ban', tone: 'am' },
  'truck.assigned': { icon: 'truck', tone: 'bl' },
  'rejection.created': { icon: 'alert', tone: 'rd' },
};

/** The row's icon tile (board 37). `icon` is an app icon name. */
export function tileFor(kind: NotificationKind): { icon: string; tone: NotificationTone } {
  return TILES[kind];
}
