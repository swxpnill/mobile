import {
  type AssignTruckBody,
  type EditTruckBody,
  type OrderLine,
  type SubOrder,
  type Truck,
  type UnitBasis,
  driverPhoneSchema,
  formatLength,
  parseQtyInput,
  planKgSchema,
  toDisplayQty,
  vehicleNoSchema,
} from '@tonnage/shared';
import { ApiError } from '../../api/client';
import { messageFor } from '../messages';
import { phoneForInput } from './truckStateMeta';

export const NO_CUSTOMER = 'Add a customer to this order before assigning a vehicle';

export interface PlanRowState {
  checked: boolean;
  /** As typed, in the person's unit. */
  qty: string;
}

export interface AssignForm {
  vehicleNo: string;
  /** null = Self (own vehicle). */
  transporter: { id: string; name: string } | null;
  driverName: string;
  driverPhone: string;
  lrNo: string;
  plan: Record<string, PlanRowState>;
  plantId: string | null;
}

export const lineLabel = (l: Pick<OrderLine, 'productName' | 'length'>) => `${l.productName} · ${formatLength(l.length)}`;

/** Left to plan on a line; on edit the truck's own plan for it counts as free again. May be < 0. */
export function lineAssignable(l: OrderLine, truck?: Pick<Truck, 'plan'>): number {
  const own = truck?.plan.find((p) => p.orderLineId === l.id)?.plannedKg ?? 0;
  return l.pendingKg - l.reservedKg + own;
}

const qtyText = (kg: number, basis: UnitBasis) => toDisplayQty(kg, basis).replace(/,/g, '');

/** A new truck: every line with something left comes checked, prefilled with what is left. */
export function initialForm(sub: SubOrder, basis: UnitBasis, truck?: Truck): AssignForm {
  const plan: Record<string, PlanRowState> = {};
  for (const l of sub.lines) {
    const mine = truck?.plan.find((p) => p.orderLineId === l.id);
    const left = Math.max(0, lineAssignable(l, truck));
    plan[l.id] = mine
      ? { checked: true, qty: qtyText(mine.plannedKg, basis) }
      : { checked: !truck && left > 0, qty: left > 0 ? qtyText(left, basis) : '' };
  }
  return {
    vehicleNo: truck?.vehicleNo ?? '',
    transporter: truck?.transporter ?? null,
    driverName: truck?.driverName ?? '',
    driverPhone: truck ? phoneForInput(truck.driverPhone) : '',
    lrNo: truck?.lrNo ?? '',
    plan,
    plantId: truck?.plantId ?? null,
  };
}

export type Checked =
  | { ok: true; vehicleNo: string; driverPhone: string; plan: AssignTruckBody['plan'] }
  | { ok: false; errors: Partial<Record<'vehicleNo' | 'driverName' | 'driverPhone' | 'plan', string>> };

/** Field errors, or the cleaned values the API takes. `withPlan` false: the plan is not sent. */
export function check(form: AssignForm, sub: SubOrder, basis: UnitBasis, withPlan: boolean): Checked {
  const errors: Partial<Record<'vehicleNo' | 'driverName' | 'driverPhone' | 'plan', string>> = {};
  const v = vehicleNoSchema.safeParse(form.vehicleNo);
  if (!v.success) errors.vehicleNo = 'Enter the vehicle number, like CG 04 MK 2291';
  if (form.driverName.trim() === '') errors.driverName = "Enter the driver's name";
  const p = driverPhoneSchema.safeParse(form.driverPhone);
  if (!p.success) errors.driverPhone = 'Enter a 10-digit number';
  const plan: AssignTruckBody['plan'] = [];
  if (withPlan) {
    for (const l of sub.lines) {
      const row = form.plan[l.id];
      if (!row?.checked) continue;
      const kg = parseQtyInput(row.qty, basis);
      if (!kg.ok || !planKgSchema.safeParse(kg.value).success) {
        errors.plan = `Enter the planned quantity for ${lineLabel(l)}`;
        break;
      }
      plan.push({ orderLineId: l.id, plannedKg: kg.value });
    }
    if (!errors.plan && plan.length === 0) errors.plan = 'Tick at least one line to load';
  }
  if (Object.keys(errors).length > 0 || !v.success || !p.success) return { ok: false, errors };
  return { ok: true, vehicleNo: v.data, driverPhone: p.data, plan };
}

/** Only what changed, plus the version the person saw (the server answers STALE otherwise). */
export function editBody(
  form: AssignForm,
  ok: Extract<Checked, { ok: true }>,
  truck: Truck,
  withPlan: boolean,
): EditTruckBody {
  const body: EditTruckBody = { version: truck.version };
  const lr = form.lrNo.trim();
  if ((truck.lrNo ?? '') !== lr) body.lrNo = lr === '' ? null : lr;
  if (truck.state === 'dispatched') return body; // only the LR can change now (TRUCK_LOCKED)
  if (ok.vehicleNo !== truck.vehicleNo) body.vehicleNo = ok.vehicleNo;
  if ((form.transporter?.id ?? null) !== (truck.transporter?.id ?? null)) body.transporterId = form.transporter?.id ?? null;
  if (form.driverName.trim() !== truck.driverName) body.driverName = form.driverName.trim();
  if (ok.driverPhone !== truck.driverPhone) body.driverPhone = ok.driverPhone;
  if (withPlan) {
    const same =
      ok.plan.length === truck.plan.length &&
      ok.plan.every((p) => truck.plan.some((x) => x.orderLineId === p.orderLineId && x.plannedKg === p.plannedKg));
    if (!same) body.plan = ok.plan;
  }
  return body;
}

/** What to say when an assign or edit is refused. */
export function failure(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'STALE':
        return 'Someone else changed this truck. Your changes are kept: reload the latest, then save again.';
      case 'CUSTOMER_REQUIRED':
        return NO_CUSTOMER;
      case 'ORDER_LOCKED':
        return 'This sub-order is closed. Reopen it to assign a vehicle.';
      case 'PLANT_REQUIRED':
        return 'Choose the plant that loads this truck';
      case 'PLANT_INACTIVE':
      case 'COMPANY_INACTIVE':
        return 'This plant is not active. Ask the owner to turn it back on.';
      case 'TRUCK_LOCKED':
        return 'This truck is dispatched or cancelled: only the LR number can change.';
      case 'LINE_NOT_ON_ORDER':
        return 'A line of this plan was removed from the order. Check the plan again.';
      case 'VALIDATION':
        return 'Check the details and try again.';
    }
  }
  return messageFor(e);
}
