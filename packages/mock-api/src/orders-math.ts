import {
  type LineQty,
  type OpenTruck,
  type OrderStatus,
  type QtyTotals,
  type SubOrderStatus,
  financialYear,
  orderStatus,
  subOrderStatus,
  totalsOf,
} from '@tonnage/shared';
import type { MockState, OrderLineRec, OrderRec, SubOrderRec, TruckRec } from './store.ts';

const OPEN_TRUCK_STATES: ReadonlySet<TruckRec['state']> = new Set(['assigned', 'at_gate', 'loading']);

export function isOpenTruck(t: TruckRec): boolean {
  return OPEN_TRUCK_STATES.has(t.state);
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export interface OrderMath {
  subOrdersOf(orderId: string): SubOrderRec[];
  linesOf(subOrderId: string): OrderLineRec[];
  trucksOf(subOrderId: string): TruckRec[];
  openTrucksOf(subOrderId: string): OpenTruck[];
  lineQty(line: OrderLineRec): LineQty;
  subOrderTotals(sub: SubOrderRec): QtyTotals;
  subOrderStatus(sub: SubOrderRec): SubOrderStatus;
  orderStatus(order: OrderRec): OrderStatus;
}

/**
 * Quantities and derived statuses over one state snapshot (§5.1, §5.3). Indexes are built once,
 * so a list of N orders costs one pass over trucks and lines, not one per line. Build a new one
 * after mutating the state.
 */
export function orderMath(state: MockState): OrderMath {
  const subsByOrder = new Map<string, SubOrderRec[]>();
  const linesBySub = new Map<string, OrderLineRec[]>();
  const trucksBySub = new Map<string, TruckRec[]>();
  const dispatchedByLine = new Map<string, number>();
  const reservedByLine = new Map<string, number>();

  for (const s of state.subOrders) push(subsByOrder, s.orderId, s);
  for (const l of state.orderLines) push(linesBySub, l.subOrderId, l);
  for (const t of state.trucks) {
    push(trucksBySub, t.subOrderId, t);
    if (t.state === 'dispatched') {
      for (const a of t.allocations) {
        dispatchedByLine.set(a.orderLineId, (dispatchedByLine.get(a.orderLineId) ?? 0) + a.netKg);
      }
    } else if (isOpenTruck(t)) {
      for (const p of t.plan) {
        reservedByLine.set(p.orderLineId, (reservedByLine.get(p.orderLineId) ?? 0) + p.plannedKg);
      }
    }
  }

  const statusCache = new Map<string, SubOrderStatus>();
  const lineQty = (l: OrderLineRec): LineQty => ({
    orderedKg: l.orderedKg,
    dispatchedKg: dispatchedByLine.get(l.id) ?? 0,
    closedKg: l.closedKg,
    reservedKg: reservedByLine.get(l.id) ?? 0,
  });
  const linesOf = (id: string) => linesBySub.get(id) ?? [];

  const subStatus = (sub: SubOrderRec): SubOrderStatus => {
    let s = statusCache.get(sub.id);
    if (s === undefined) {
      s = subOrderStatus({ closeKind: sub.closeKind, lines: linesOf(sub.id).map(lineQty) });
      statusCache.set(sub.id, s);
    }
    return s;
  };

  return {
    subOrdersOf: (id) => subsByOrder.get(id) ?? [],
    linesOf,
    trucksOf: (id) => trucksBySub.get(id) ?? [],
    openTrucksOf: (id) =>
      (trucksBySub.get(id) ?? [])
        .filter(isOpenTruck)
        .map((t) => ({ id: t.id, vehicleNo: t.vehicleNo, state: t.state, tareKg: t.tareKg })),
    lineQty,
    subOrderTotals: (sub) => totalsOf(linesOf(sub.id).map(lineQty)),
    subOrderStatus: subStatus,
    orderStatus: (order) =>
      orderStatus({ isDraft: false, subOrders: (subsByOrder.get(order.id) ?? []).map(subStatus) }),
  };
}

/**
 * Next value of a per-tenant series for the financial year of `at` (§5.3 numbering). In B2 this
 * is a row-locked `number_series` update; here the request queue already serialises it.
 */
export function nextNumber(state: MockState, tenantId: string, key: string, at: string | number): number {
  const fy = financialYear(at);
  let rec = state.numberSeries.find((r) => r.tenantId === tenantId && r.key === key && r.fy === fy);
  if (!rec) {
    rec = { tenantId, key, fy, next: 1 };
    state.numberSeries.push(rec);
  }
  const n = rec.next;
  rec.next += 1;
  return n;
}
