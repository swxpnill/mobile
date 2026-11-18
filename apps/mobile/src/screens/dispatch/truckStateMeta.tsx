import { type Task, type Truck, type TruckState, formatLength, formatMobile } from '@tonnage/shared';
import type { BadgeKind } from '../../ui';

/** Status words (plan): Assigned, At gate, Loading, Dispatched, Cancelled. */
export const TRUCK_STATE_META: Record<TruckState, { label: string; kind: BadgeKind; step: number }> = {
  assigned: { label: 'Assigned', kind: 'vi', step: 1 },
  at_gate: { label: 'At gate', kind: 'br', step: 1 },
  loading: { label: 'Loading', kind: 'wn', step: 2 },
  dispatched: { label: 'Dispatched', kind: 'ok', step: 4 },
  cancelled: { label: 'Cancelled', kind: 'nu', step: 0 },
};

/** Truck progress; there is no separate "gross weighed" step: gross is the dispatch. */
export const TRUCK_STEPS = ['Assigned', 'Tare', 'Gross', 'Dispatched'] as const;

export const isOpenState = (s: TruckState) => s === 'assigned' || s === 'at_gate' || s === 'loading';

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
    version: t.version,
    changedAt: t.tareAt ?? t.atGateAt ?? t.assignedAt,
  };
}
