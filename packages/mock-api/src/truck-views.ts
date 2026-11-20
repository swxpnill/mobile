import { type Task, type Truck, formatLength, istDateParts, pending, productDisplayName, subOrderNumber } from '@tonnage/shared';
import { orderMath } from './orders-math.ts';
import type { OrderCtx } from './order-views.ts';
import type { MockState, TruckRec } from './store.ts';

/** One vehicle however it was typed: "CG 04 MK 2291" and "cg04mk2291" are the same truck. */
export const vehicleKey = (vehicleNo: string): string => vehicleNo.replace(/\s+/g, '').toLowerCase();

/** Same calendar day in IST (business time zone). */
export function sameIstDay(a: string | number, b: string | number): boolean {
  const x = istDateParts(a);
  const y = istDateParts(b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** Newest assignment first; ties by id so the order is total. */
export function newestFirst(x: { assignedAt: string; id: string }, y: { assignedAt: string; id: string }): number {
  if (x.assignedAt !== y.assignedAt) return x.assignedAt < y.assignedAt ? 1 : -1;
  return x.id < y.id ? 1 : x.id > y.id ? -1 : 0;
}

/** Board order: awaiting approval (TON-57, the office's to-do), loading, arrived, assigned, then dispatched. */
export const OPEN_STATE_RANK: Record<string, number> = { weighed: 0, loading: 1, at_gate: 2, assigned: 3, dispatched: 4 };

/** Awaiting approval first; waiting trucks oldest first, dispatched ones newest first; ties by id. */
export function boardOrder(
  x: Pick<TruckRec, 'id' | 'state' | 'assignedAt' | 'dispatchedAt'>,
  y: Pick<TruckRec, 'id' | 'state' | 'assignedAt' | 'dispatchedAt'>,
): number {
  const r = (OPEN_STATE_RANK[x.state] ?? 9) - (OPEN_STATE_RANK[y.state] ?? 9);
  if (r !== 0) return r;
  if (x.state === 'dispatched') {
    const dx = x.dispatchedAt ?? '';
    const dy = y.dispatchedAt ?? '';
    if (dx !== dy) return dx < dy ? 1 : -1;
  } else if (x.assignedAt !== y.assignedAt) {
    return x.assignedAt < y.assignedAt ? -1 : 1;
  }
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

// Serializers build fresh plain objects (never state references), so responses can't alias state.

function parentsOf(state: MockState, t: TruckRec) {
  const sub = state.subOrders.find((s) => s.id === t.subOrderId);
  const order = state.orders.find((o) => o.id === t.orderId);
  if (!sub || !order) throw new Error(`truck ${t.id} has no sub-order or order`);
  return { sub, order };
}

const netOf = (t: TruckRec) => (t.grossKg !== null && t.tareKg !== null ? t.grossKg - t.tareKg : null);

/**
 * Full truck for owner, city staff and plant head. `earningRupees` (Σ of the truck's ledger rows)
 * only on broker orders; the pipeline strips it for plant roles with the other money keys.
 */
export function toTruck(c: OrderCtx, t: TruckRec, opts: { withWeighments: boolean }): Truck {
  const { sub, order } = parentsOf(c.state, t);
  const company = c.companyById.get(sub.companyId);
  const lineById = new Map(c.math.linesOf(sub.id).map((l) => [l.id, l]));
  const transporter = t.transporterId ? c.partyById.get(t.transporterId) : undefined;
  const userRef = (id: string) => ({ id, name: c.userNameById.get(id) ?? '' });
  const truck: Truck = {
    id: t.id,
    subOrderId: sub.id,
    subOrderNumber: subOrderNumber(order.number, sub.suffix),
    orderId: order.id,
    customerName: order.customerId ? (c.partyById.get(order.customerId)?.name ?? null) : null,
    companyId: sub.companyId,
    companyCode: company?.code ?? '',
    plantId: t.plantId,
    plantName: c.state.plants.find((p) => p.id === t.plantId)?.name ?? '',
    vehicleNo: t.vehicleNo,
    transporter: transporter ? { id: transporter.id, name: transporter.name } : null,
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    lrNo: t.lrNo,
    state: t.state,
    plan: t.plan.map((p) => {
      const line = lineById.get(p.orderLineId);
      return {
        orderLineId: p.orderLineId,
        productName: line ? (c.productNameById.get(line.productId)?.name ?? '') : '',
        length: line ? { ...line.length } : null,
        plannedKg: p.plannedKg,
      };
    }),
    tareKg: t.tareKg,
    grossKg: t.grossKg,
    netKg: netOf(t),
    allocations: t.allocations.map((a) => ({ ...a })),
    loadingSlipNo: t.loadingSlipNo,
    assignedAt: t.assignedAt,
    assignedBy: userRef(t.assignedBy),
    atGateAt: t.atGateAt,
    tareAt: t.tareAt,
    weighedAt: t.weighedAt,
    dispatchedAt: t.dispatchedAt,
    cancelledAt: t.cancelledAt,
    cancelReason: t.cancelReason,
    weighments: opts.withWeighments
      ? c.state.weighments
          .filter((w) => w.truckId === t.id)
          .map((w) => ({
            id: w.id,
            kind: w.kind,
            kg: w.kg,
            by: userRef(w.enteredBy),
            capturedAt: w.capturedAt,
            superseded: w.supersededBy !== null,
            clockSkew: w.clockSkewFlag,
          }))
      : [],
    version: t.version,
  };
  if (order.brokerId !== null) {
    truck.earningRupees = c.state.brokerLedger
      .filter((r) => r.truckId === t.id)
      .reduce((sum, r) => sum + r.amountRupees, 0);
  }
  return truck;
}

/** The supervisor's phone copy of a truck: product names and kg only, never money (§6.2). */
/** "TMT Fe500D · 12 mm · 12 m": the task has no length field, and two lines can share a product. */
function lineLabel(state: MockState, orderLineId: string): string {
  const line = state.orderLines.find((l) => l.id === orderLineId);
  const product = line ? state.products.find((x) => x.id === line.productId) : undefined;
  return line && product ? `${productDisplayName(product)} · ${formatLength(line.length)}` : '';
}

function subLines(state: MockState, subOrderId: string): Task['lines'] {
  const math = orderMath(state);
  return math.linesOf(subOrderId).map((l) => ({
    orderLineId: l.id,
    productName: lineLabel(state, l.id),
    pendingKg: pending(math.lineQty(l)),
  }));
}

export function toTask(state: MockState, t: TruckRec): Task {
  const { sub, order } = parentsOf(state, t);
  const partyName = (id: string | null) => (id ? (state.parties.find((p) => p.id === id)?.name ?? null) : null);
  return {
    truckId: t.id,
    vehicleNo: t.vehicleNo,
    transporterName: partyName(t.transporterId),
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    customerName: partyName(order.customerId),
    subOrderNumber: subOrderNumber(order.number, sub.suffix),
    companyCode: state.companies.find((c) => c.id === sub.companyId)?.code ?? '',
    state: t.state,
    tareKg: t.tareKg,
    tareAt: t.tareAt,
    tareDeviceId: t.tareDeviceId,
    plan: t.plan.map((p) => ({ orderLineId: p.orderLineId, productName: lineLabel(state, p.orderLineId), plannedKg: p.plannedKg })),
    // TON-57: every line of the sub-order, for "Add product" on the phone.
    lines: subLines(state, t.subOrderId),
    version: t.version,
    changedAt: t.updatedAt,
  };
}
