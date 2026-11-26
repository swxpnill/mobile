import {
  type LineQty,
  type OpenTruck,
  type QtyTotals,
  type SubOrderStatus,
  isOpenTruckState,
  subOrderStatus,
  totalsOf,
} from '@tonnage/shared';
import type {
  orderLines,
  orders,
  subOrders,
  truckAllocations,
  truckPlanLines,
  trucks,
} from '../db/schema/index.ts';

export type OrderRow = typeof orders.$inferSelect;
export type SubOrderRow = typeof subOrders.$inferSelect;
export type LineRow = typeof orderLines.$inferSelect;
export type TruckRow = typeof trucks.$inferSelect;
export type PlanRow = typeof truckPlanLines.$inferSelect;
export type AllocationRow = typeof truckAllocations.$inferSelect;

/** A truck with its plan and (once weighed) its net per line, each in `position` order. */
export interface TruckGraph {
  truck: TruckRow;
  plan: PlanRow[];
  allocations: AllocationRow[];
}

/** A sub-order with its lines (creation order) and every truck on it (oldest first). */
export interface SubOrderGraph {
  sub: SubOrderRow;
  lines: LineRow[];
  trucks: TruckGraph[];
}

/** An order and everything its responses derive from; sub-orders in suffix order (A, B, …). */
export interface OrderGraph {
  order: OrderRow;
  subOrders: SubOrderGraph[];
}

/** Quantities and derived statuses of one order graph (§5.1, §5.3): the mock's `orderMath`. */
export interface GraphMath {
  lineQty(line: LineRow): LineQty;
  subOrderTotals(sub: SubOrderGraph): QtyTotals;
  subOrderStatus(sub: SubOrderGraph): SubOrderStatus;
  openTrucksOf(sub: SubOrderGraph): OpenTruck[];
}

/**
 * Dispatched kg are the net of dispatched trucks; reserved kg the plan of open ones (TON-57's
 * `weighed`, awaiting approval, is open), summed per line. Built once per graph.
 */
export function graphMath(g: OrderGraph): GraphMath {
  const dispatchedByLine = new Map<string, number>();
  const reservedByLine = new Map<string, number>();
  const add = (m: Map<string, number>, id: string, kg: number) => m.set(id, (m.get(id) ?? 0) + kg);
  for (const s of g.subOrders) {
    for (const t of s.trucks) {
      if (t.truck.state === 'dispatched') {
        for (const a of t.allocations) add(dispatchedByLine, a.orderLineId, a.netKg);
      } else if (isOpenTruckState(t.truck.state)) {
        for (const p of t.plan) add(reservedByLine, p.orderLineId, p.plannedKg);
      }
    }
  }
  const lineQty = (l: LineRow): LineQty => ({
    orderedKg: l.orderedKg,
    dispatchedKg: dispatchedByLine.get(l.id) ?? 0,
    closedKg: l.closedKg,
    reservedKg: reservedByLine.get(l.id) ?? 0,
  });
  const statusCache = new Map<string, SubOrderStatus>();
  return {
    lineQty,
    subOrderTotals: (s) => totalsOf(s.lines.map(lineQty)),
    subOrderStatus: (s) => {
      let status = statusCache.get(s.sub.id);
      if (status === undefined) {
        status = subOrderStatus({ closeKind: s.sub.closeKind, lines: s.lines.map(lineQty) });
        statusCache.set(s.sub.id, status);
      }
      return status;
    },
    openTrucksOf: (s) =>
      s.trucks
        .filter((t) => isOpenTruckState(t.truck.state))
        .map(({ truck: t }) => ({ id: t.id, vehicleNo: t.vehicleNo, state: t.state, tareKg: t.tareKg })),
  };
}

/** Net kg a truck carried (its allocations), as the mock sums them. */
export const truckNetKg = (t: TruckGraph): number => t.allocations.reduce((sum, a) => sum + a.netKg, 0);
