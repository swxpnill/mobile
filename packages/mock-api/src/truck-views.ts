import { type Task, type Truck, formatLength, productDisplayName, subOrderNumber } from '@tonnage/shared';
import type { OrderCtx } from './order-views.ts';
import type { MockState, TruckRec } from './store.ts';

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
    tareDeviceId: t.tareDeviceId,
    plan: t.plan.map((p) => {
      const line = state.orderLines.find((l) => l.id === p.orderLineId);
      const product = line ? state.products.find((x) => x.id === line.productId) : undefined;
      // The task has no length field, and two lines can share a product (12 mm · 12 m and · 6 m).
      const productName = line && product ? `${productDisplayName(product)} · ${formatLength(line.length)}` : '';
      return { orderLineId: p.orderLineId, productName, plannedKg: p.plannedKg };
    }),
    version: t.version,
    changedAt: t.updatedAt,
  };
}
