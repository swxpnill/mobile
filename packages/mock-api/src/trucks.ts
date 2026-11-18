import type { TruckState } from '@tonnage/shared';
import { MINUTE, fromIso, toIso } from './clock.ts';
import { issueLoadingSlip, writeEarning } from './dispatch.ts';
import type { MockState, TruckRec, WeighmentRec } from './store.ts';
import { newId } from './views.ts';

export interface AddTruckInput {
  subOrderId: string;
  state: TruckState;
  vehicleNo: string;
  tareKg?: number;
  plan: { orderLineId: string; plannedKg: number }[];
  allocations?: { orderLineId: string; netKg: number }[];
  /** Demo seed details; contract fixtures leave them out and get neutral defaults. */
  transporterId?: string | null;
  driverName?: string;
  driverPhone?: string;
  lrNo?: string | null;
  /** Who assigned it (default: whoever booked the order). */
  assignedBy?: string;
  /** Who weighed it and on which phone (default: the assigner, device `fixture`). */
  weighedBy?: string;
  deviceId?: string;
}

/** Earlier steps of a seeded truck, before the time of its latest step (never before booking). */
const STEP_BEFORE = { assigned: 90 * MINUTE, atGate: 60 * MINUTE, tare: 45 * MINUTE } as const;

/**
 * Test and demo hook: inserts a truck in any state, as if the real flow had brought it there, with
 * its weighments, and for a dispatched truck its loading slip and broker earning. `nowMs` is the
 * time of its latest step (assignment, gate, tare or dispatch). Refuses inputs the real flow could
 * never produce (unknown sub-order, lines of another sub-order, a dispatched truck without
 * allocations) so fixtures cannot fake impossible data.
 */
export function addTruck(state: MockState, input: AddTruckInput, nowMs: number): string {
  const sub = state.subOrders.find((s) => s.id === input.subOrderId);
  if (!sub) throw new Error(`addTruck: unknown sub-order ${input.subOrderId}`);
  const order = state.orders.find((o) => o.id === sub.orderId);
  if (!order) throw new Error(`addTruck: sub-order ${sub.id} has no order`);
  const lineIds = new Set(state.orderLines.filter((l) => l.subOrderId === sub.id).map((l) => l.id));
  const allocations = input.allocations ?? [];
  for (const row of [...input.plan, ...allocations]) {
    if (!lineIds.has(row.orderLineId)) {
      throw new Error(`addTruck: line ${row.orderLineId} is not on sub-order ${sub.id}`);
    }
  }
  if (input.state === 'dispatched' && allocations.length === 0) {
    throw new Error('addTruck: a dispatched truck needs allocations');
  }
  if (input.state !== 'dispatched' && allocations.length > 0) {
    throw new Error('addTruck: only a dispatched truck has allocations');
  }
  const plant = state.plants.find((p) => p.companyId === sub.companyId && p.active);
  if (!plant) throw new Error(`addTruck: company ${sub.companyId} has no active plant`);

  const booked = fromIso(sub.createdAt);
  const stepAt = (before: number) => toIso(Math.max(booked, nowMs - before));
  const at = toIso(nowMs);
  const s = input.state;
  const tareKg = input.tareKg ?? null;
  const net = allocations.reduce((n, a) => n + a.netKg, 0);
  const assignedAt = s === 'assigned' ? at : stepAt(STEP_BEFORE.assigned);
  const tareAt = tareKg === null ? null : s === 'dispatched' ? stepAt(STEP_BEFORE.tare) : at;
  const assignedBy = input.assignedBy ?? order.createdBy;
  const weighedBy = input.weighedBy ?? assignedBy;
  const deviceId = input.deviceId ?? 'fixture';

  const rec: TruckRec = {
    id: newId(),
    tenantId: sub.tenantId,
    orderId: order.id,
    subOrderId: sub.id,
    plantId: plant.id,
    vehicleNo: input.vehicleNo,
    transporterId: input.transporterId ?? null,
    driverName: input.driverName ?? 'Driver',
    driverPhone: input.driverPhone ?? '',
    lrNo: input.lrNo ?? null,
    state: s,
    tareKg,
    grossKg: s === 'dispatched' && tareKg !== null ? tareKg + net : null,
    plan: input.plan.map((r) => ({ ...r })),
    allocations: allocations.map((r) => ({ ...r })),
    loadingSlipNo: null,
    assignedAt,
    assignedBy,
    atGateAt: s === 'at_gate' ? at : s === 'assigned' ? null : stepAt(STEP_BEFORE.atGate),
    tareAt,
    tareDeviceId: tareKg === null ? null : deviceId,
    dispatchedAt: s === 'dispatched' ? at : null,
    cancelledAt: s === 'cancelled' ? at : null,
    cancelledBy: s === 'cancelled' ? assignedBy : null,
    cancelReason: s === 'cancelled' ? 'Cancelled' : null,
    version: 1,
    createdAt: assignedAt,
    updatedAt: at,
  };
  state.trucks.push(rec);

  const weigh = (kind: WeighmentRec['kind'], kg: number, when: string) =>
    state.weighments.push({
      id: newId(),
      tenantId: rec.tenantId,
      truckId: rec.id,
      kind,
      kg,
      enteredBy: weighedBy,
      deviceId,
      clientEventId: newId(),
      capturedAtDevice: when,
      capturedAt: when,
      receivedAt: when,
      clockSkewFlag: false,
      supersededBy: null,
    });
  if (tareKg !== null && tareAt !== null) weigh('tare', tareKg, tareAt);
  if (s === 'dispatched') {
    if (rec.grossKg !== null) weigh('gross', rec.grossKg, at);
    rec.loadingSlipNo = issueLoadingSlip(state, rec, at);
    writeEarning(state, rec, at, weighedBy);
  }
  return rec.id;
}
