import {
  type BrokerLedger,
  type LedgerEntry,
  type LedgerRow,
  type BrokerFact,
  brokerDue,
  formatLength,
  istDateOf,
  monthOf,
  monthTotals,
  productDisplayName,
  subOrderNumber,
  unpaidKg,
} from '@tonnage/shared';
import type { BrokerLedgerRec, MockState } from './store.ts';

const sumKg = (rec: BrokerLedgerRec): number => rec.breakdown.reduce((n, b) => n + b.netKg, 0);

/** The IST day of the truck's dispatch, when the row is an earning of a dispatched truck. */
function truckDayOf(state: MockState, rec: BrokerLedgerRec): string | undefined {
  if (rec.kind !== 'earning' || rec.truckId === null) return undefined;
  const truck = state.trucks.find((t) => t.id === rec.truckId);
  return truck?.dispatchedAt ? istDateOf(truck.dispatchedAt) : undefined;
}

/**
 * The IST day a row counts on (Ruling 4). A truck's first earning belongs to the IST day of its
 * gross `capturedAt` (its `dispatchedAt`), not of the sync, so a truck captured at 23:50 and synced
 * after midnight stays in its own month. A correction's reversal and replacement earning count on
 * the day of the correction, so a later month moves only by the difference. A payment counts on
 * the date it was made.
 */
export function entryDateOf(state: MockState, rec: BrokerLedgerRec): string {
  if (rec.kind === 'payment' && rec.paidOn !== null) return rec.paidOn;
  const truckDay = truckDayOf(state, rec);
  if (truckDay !== undefined) {
    const first = state.brokerLedger.find((r) => r.kind === 'earning' && r.truckId === rec.truckId);
    if (first?.id === rec.id) return truckDay;
  }
  return istDateOf(rec.createdAt);
}

function toRow(state: MockState, rec: BrokerLedgerRec): LedgerRow {
  const truckDay = truckDayOf(state, rec);
  return {
    id: rec.id,
    kind: rec.kind,
    amountRupees: rec.amountRupees,
    netKg: sumKg(rec),
    entryDate: entryDateOf(state, rec),
    // FIFO places every earning of a truck, a replacement included, on its dispatch day.
    ...(truckDay === undefined ? {} : { fifoDate: truckDay }),
    createdAt: rec.createdAt,
    reversesId: rec.reversesId,
  };
}

/** Every ledger row of one broker as the pure ledger rules see it. */
export function ledgerRows(state: MockState, brokerId: string): LedgerRow[] {
  return state.brokerLedger.filter((r) => r.brokerId === brokerId).map((r) => toRow(state, r));
}

/** A broker's rows for the report facts: each carries its earning lines, split into commission and overprice. */
export function brokerFactRows(state: MockState, brokerId: string): BrokerFact['rows'] {
  return state.brokerLedger
    .filter((r) => r.brokerId === brokerId)
    .map((r) => ({ ...toRow(state, r), earningLines: r.breakdown.map((b) => ({ ...b })) }));
}

export function toLedgerEntry(state: MockState, rec: BrokerLedgerRec): LedgerEntry {
  const truck = rec.truckId === null ? undefined : state.trucks.find((t) => t.id === rec.truckId);
  const order = truck ? state.orders.find((o) => o.id === truck.orderId) : undefined;
  const sub = truck ? state.subOrders.find((s) => s.id === truck.subOrderId) : undefined;
  const lineName = (orderLineId: string): string => {
    const line = state.orderLines.find((l) => l.id === orderLineId);
    const product = line ? state.products.find((p) => p.id === line.productId) : undefined;
    return line && product ? `${productDisplayName(product)} · ${formatLength(line.length)}` : '';
  };
  const isPayment = rec.kind === 'payment' && rec.mode !== null && rec.paidRupees !== null && rec.paidOn !== null;
  return {
    id: rec.id,
    kind: rec.kind,
    amountRupees: rec.amountRupees,
    entryDate: entryDateOf(state, rec),
    createdAt: rec.createdAt,
    createdBy: { id: rec.createdBy, name: state.users.find((u) => u.id === rec.createdBy)?.name ?? '' },
    truck:
      truck && order && sub
        ? {
            truckId: truck.id,
            vehicleNo: truck.vehicleNo,
            orderId: order.id,
            orderNumber: order.number,
            subOrderNumber: subOrderNumber(order.number, sub.suffix),
            netKg: sumKg(rec),
          }
        : null,
    earningLines: rec.breakdown.map((b) => ({
      productName: lineName(b.orderLineId),
      netKg: b.netKg,
      commissionPerMt: b.commissionPerMt,
      overpricePerMt: b.overpricePerMt,
    })),
    payment: isPayment
      ? { mode: rec.mode!, utr: rec.utr, paidRupees: rec.paidRupees!, tdsRupees: rec.tdsRupees ?? 0, paidOn: rec.paidOn! }
      : null,
    reversesId: rec.reversesId,
    reversedById: state.brokerLedger.find((r) => r.reversesId === rec.id)?.id ?? null,
    note: rec.note,
  };
}

/** The ledger header: due, kg dispatched and not yet paid, and this IST month's earned and paid. */
export function brokerSummary(state: MockState, brokerId: string, today: string): BrokerLedger['summary'] {
  const rows = ledgerRows(state, brokerId);
  const month = monthOf(today);
  const { earnedRupees, paidRupees } = monthTotals(rows, month);
  return {
    dueRupees: brokerDue(rows),
    unpaidKg: unpaidKg(rows),
    month,
    earnedThisMonthRupees: earnedRupees,
    paidThisMonthRupees: paidRupees,
  };
}
