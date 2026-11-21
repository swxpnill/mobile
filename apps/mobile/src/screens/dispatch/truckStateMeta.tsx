import { type Task, type Truck, type TruckState, formatLength, formatMobile, isOpenTruckState } from '@tonnage/shared';
import type { BadgeKind } from '../../ui';

/**
 * Status words (TON-57): Assigned, Arrived (`at_gate`; the sync event keeps its name), Loading,
 * Awaiting approval (weights saved, the office approves), Dispatched, Cancelled.
 */
export const TRUCK_STATE_META: Record<TruckState, { label: string; kind: BadgeKind }> = {
  assigned: { label: 'Assigned', kind: 'vi' },
  at_gate: { label: 'Arrived', kind: 'br' },
  loading: { label: 'Loading', kind: 'wn' },
  // Never shown as dispatched before the office approves.
  weighed: { label: 'Awaiting approval', kind: 'wn' },
  dispatched: { label: 'Dispatched', kind: 'ok' },
  cancelled: { label: 'Cancelled', kind: 'nu' },
};

/** Truck progress (TON-57): five steps, the same on the board card and the truck detail. */
export const TRUCK_STEPS = ['Assigned', 'Arrived', 'Tare weighed', 'Weighed', 'Dispatched'] as const;

/**
 * How many steps of `TRUCK_STEPS` the truck has done (1–5). A cancelled truck shows how far it
 * got before it was cancelled.
 */
export function stepIndex(x: { state: TruckState; tareKg: number | null; atGateAt: string | null }): number {
  switch (x.state) {
    case 'assigned':
      return 1;
    case 'at_gate':
      return 2;
    case 'loading':
      return 3;
    case 'weighed':
      return 4;
    case 'dispatched':
      return 5;
    case 'cancelled':
      return x.tareKg !== null ? 3 : x.atGateAt !== null ? 2 : 1;
  }
}

export const isOpenState = (s: TruckState) => isOpenTruckState(s);

/** "98271 44012" from "+919827144012", for a phone field the person can edit. */
export function phoneForInput(normalized: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(normalized);
  return m ? `${m[1]} ${m[2]}` : normalized;
}

export const shownPhone = (normalized: string) => formatMobile(normalized);

/** "TMT Fe500D · 12 mm · 12 m" for a plan row. */
export function planLabel(p: Pick<Truck['plan'][number], 'productName' | 'length'>): string {
  return p.length ? `${p.productName} · ${formatLength(p.length)}` : p.productName;
}

/**
 * The supervisor's task shape for a truck (owner capture, Ruling 4): what `GET /v1/supervisor/tasks`
 * would send for it. `tareDeviceId` is not on the truck; null only means "not known here".
 */
export function truckToTask(t: Truck): Task {
  return {
    truckId: t.id,
    vehicleNo: t.vehicleNo,
    transporterName: t.transporter?.name ?? null,
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    customerName: t.customerName,
    subOrderNumber: t.subOrderNumber,
    companyCode: t.companyCode,
    state: t.state,
    tareKg: t.tareKg,
    tareAt: t.tareKg === null ? null : t.tareAt,
    tareDeviceId: null,
    plan: t.plan.map((p) => ({ orderLineId: p.orderLineId, productName: planLabel(p), plannedKg: p.plannedKg })),
    // The truck does not carry its sub-order's other lines; TON-57 Task 4 fills these from the order.
    lines: [],
    version: t.version,
    changedAt: t.tareAt ?? t.atGateAt ?? t.assignedAt,
  };
}
