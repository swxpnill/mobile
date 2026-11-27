import {
  type PlantSupervisor,
  type Task,
  type Truck,
  formatLength,
  istDateParts,
  pending,
  subOrderNumber,
} from '@tonnage/shared';
import type { weighments } from '../db/schema/index.ts';
import type { GraphMath, LineRow, OrderGraph, SubOrderGraph, TruckGraph, TruckRow } from './orderGraph.ts';
import type { OrderViewCtx } from './orders.ts';

// Ported from packages/mock-api/src/truck-views.ts: the same output for the same data (B3 Ruling 8).

export type WeighmentRow = typeof weighments.$inferSelect;

/** One vehicle however it was typed: "CG 04 MK 2291" and "cg04mk2291" are the same truck. */
export const vehicleKey = (vehicleNo: string): string => vehicleNo.replace(/\s+/g, '').toLowerCase();

/** Same calendar day in IST (business time zone). */
export function sameIstDay(a: string | number, b: string | number): boolean {
  const x = istDateParts(a);
  const y = istDateParts(b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Newest assignment first; ties by id so the order is total. */
export function newestFirst(x: TruckRow, y: TruckRow): number {
  const ax = x.assignedAt.getTime();
  const ay = y.assignedAt.getTime();
  if (ax !== ay) return ax < ay ? 1 : -1;
  return x.id < y.id ? 1 : x.id > y.id ? -1 : 0;
}

/** Board order: awaiting approval (TON-57, the office's to-do), loading, arrived, assigned, then dispatched. */
export const OPEN_STATE_RANK: Record<string, number> = { weighed: 0, loading: 1, at_gate: 2, assigned: 3, dispatched: 4 };

/** Awaiting approval first; waiting trucks oldest first, dispatched ones newest first; ties by id. */
export function boardOrder(x: TruckRow, y: TruckRow): number {
  const r = (OPEN_STATE_RANK[x.state] ?? 9) - (OPEN_STATE_RANK[y.state] ?? 9);
  if (r !== 0) return r;
  if (x.state === 'dispatched') {
    const dx = x.dispatchedAt?.toISOString() ?? '';
    const dy = y.dispatchedAt?.toISOString() ?? '';
    if (dx !== dy) return dx < dy ? 1 : -1;
  } else if (x.assignedAt.getTime() !== y.assignedAt.getTime()) {
    return x.assignedAt < y.assignedAt ? -1 : 1;
  }
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/** A truck with everything around it: its order, sub-order and the order's maths. */
export interface TruckPlace {
  graph: OrderGraph;
  sub: SubOrderGraph;
  truck: TruckGraph;
  math: GraphMath;
}

/** What truck responses need besides the order graphs, loaded once per request. */
export interface TruckViewCtx extends OrderViewCtx {
  places: ReadonlyMap<string, TruckPlace>;
  plantNameById: ReadonlyMap<string, string>;
  /** Active supervisors per plant, by name (TON-57). */
  supervisorsByPlant: ReadonlyMap<string, PlantSupervisor[]>;
  /** Transporters (and any other party a truck names) by id. */
  transporterById: ReadonlyMap<string, { id: string; name: string }>;
  weighmentsByTruck: ReadonlyMap<string, WeighmentRow[]>;
  /** Σ of each truck's ledger rows (earnings and reversals). */
  earningByTruck: ReadonlyMap<string, number>;
}

export function placeOf(c: TruckViewCtx, truckId: string): TruckPlace {
  const p = c.places.get(truckId);
  if (!p) throw new Error(`truck ${truckId} not loaded`);
  return p;
}

const netOf = (t: TruckRow): number | null => (t.grossKg !== null && t.tareKg !== null ? t.grossKg - t.tareKg : null);

/**
 * Full truck for owner, city staff and plant head. `earningRupees` (Σ of the truck's ledger rows)
 * only on broker orders; the pipeline strips it for plant roles with the other money keys.
 */
export function toTruck(c: TruckViewCtx, truckId: string, opts: { withWeighments: boolean }): Truck {
  const { graph, sub, truck: tg } = placeOf(c, truckId);
  const t = tg.truck;
  const order = graph.order;
  const lineById = new Map(sub.lines.map((l) => [l.id, l]));
  const transporter = t.transporterId ? c.transporterById.get(t.transporterId) : undefined;
  const userRef = (id: string) => ({ id, name: c.userNameById.get(id) ?? '' });
  const out: Truck = {
    id: t.id,
    subOrderId: sub.sub.id,
    subOrderNumber: subOrderNumber(order.number ?? '', sub.sub.suffix),
    orderId: order.id,
    customerName: order.customerId ? (c.partyById.get(order.customerId)?.name ?? null) : null,
    companyId: sub.sub.companyId,
    companyCode: c.companyById.get(sub.sub.companyId)?.code ?? '',
    plantId: t.plantId,
    plantName: c.plantNameById.get(t.plantId) ?? '',
    vehicleNo: t.vehicleNo,
    transporter: transporter ? { id: transporter.id, name: transporter.name } : null,
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    lrNo: t.lrNo,
    state: t.state,
    plan: tg.plan.map((p) => {
      const line = lineById.get(p.orderLineId);
      return {
        orderLineId: p.orderLineId,
        productName: line ? (c.productById.get(line.productId)?.name ?? '') : '',
        length: line ? { ...line.length } : null,
        plannedKg: p.plannedKg,
      };
    }),
    tareKg: t.tareKg,
    grossKg: t.grossKg,
    netKg: netOf(t),
    allocations: tg.allocations.map((a) => ({ orderLineId: a.orderLineId, netKg: a.netKg })),
    loadingSlipNo: t.loadingSlipNo,
    assignedAt: t.assignedAt.toISOString(),
    assignedBy: userRef(t.assignedBy),
    atGateAt: iso(t.atGateAt),
    tareAt: iso(t.tareAt),
    weighedAt: iso(t.weighedAt),
    dispatchedAt: iso(t.dispatchedAt),
    cancelledAt: iso(t.cancelledAt),
    cancelReason: t.cancelReason,
    weighments: opts.withWeighments
      ? (c.weighmentsByTruck.get(t.id) ?? []).map((w) => ({
          id: w.id,
          kind: w.kind,
          kg: w.kg,
          by: userRef(w.enteredBy),
          capturedAt: w.capturedAt.toISOString(),
          superseded: w.supersededBy !== null,
          clockSkew: w.clockSkewFlag,
        }))
      : [],
    supervisors: opts.withWeighments ? (c.supervisorsByPlant.get(t.plantId) ?? []).map((s) => ({ ...s })) : [],
    version: t.version,
  };
  if (order.brokerId !== null) out.earningRupees = c.earningByTruck.get(t.id) ?? 0;
  return out;
}

/** "TMT Fe500D · 12 mm · 12 m": the task has no length field, and two lines can share a product. */
function lineLabel(c: TruckViewCtx, line: LineRow | undefined): string {
  const product = line ? c.productById.get(line.productId) : undefined;
  return line && product ? `${product.name} · ${formatLength(line.length)}` : '';
}

/** The supervisor's phone copy of a truck: product names and kg only, never money (§6.2). */
export function toTask(c: TruckViewCtx, truckId: string): Task {
  const { graph, sub, truck: tg, math } = placeOf(c, truckId);
  const t = tg.truck;
  const order = graph.order;
  const lineById = new Map(sub.lines.map((l) => [l.id, l]));
  const partyName = (id: string | null) => (id ? (c.partyById.get(id)?.name ?? c.transporterById.get(id)?.name ?? null) : null);
  return {
    truckId: t.id,
    vehicleNo: t.vehicleNo,
    transporterName: t.transporterId ? (c.transporterById.get(t.transporterId)?.name ?? null) : null,
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    customerName: partyName(order.customerId),
    subOrderNumber: subOrderNumber(order.number ?? '', sub.sub.suffix),
    companyCode: c.companyById.get(sub.sub.companyId)?.code ?? '',
    state: t.state,
    tareKg: t.tareKg,
    tareAt: iso(t.tareAt),
    tareDeviceId: t.tareDeviceId,
    plan: tg.plan.map((p) => ({ orderLineId: p.orderLineId, productName: lineLabel(c, lineById.get(p.orderLineId)), plannedKg: p.plannedKg })),
    // TON-57: every line of the sub-order, for "Add product" on the phone.
    lines: sub.lines.map((l) => ({ orderLineId: l.id, productName: lineLabel(c, l), pendingKg: pending(math.lineQty(l)) })),
    version: t.version,
    changedAt: t.updatedAt.toISOString(),
  };
}
