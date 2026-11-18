import {
  type BookedLineFact,
  type BrokerFact,
  type OpenSubOrderFact,
  type ReportFacts,
  type ReportKind,
  type TruckLineFact,
  billedRate,
  isTerminal,
  lineValue,
  productDisplayName,
  subOrderNumber,
} from '@tonnage/shared';
import { brokerFactRows } from './ledger-views.ts';
import { orderMath } from './orders-math.ts';
import type { MockState } from './store.ts';

const byId = <T extends { id: string }>(rows: readonly T[]): Map<string, T> => new Map(rows.map((r) => [r.id, r]));

/** The kinds that read lifted kg. */
const LIFTED: ReadonlySet<ReportKind> = new Set([
  'dispatch-register',
  'unit-sales',
  'customer-wise',
  'product-wise',
  'loading-variance',
]);

/** One fact per allocation of every dispatched truck (a line with a plan but no net weight is not a lifted line). */
function truckLines(state: MockState, tenantId: string): TruckLineFact[] {
  const orders = byId(state.orders);
  const subs = byId(state.subOrders);
  const lines = byId(state.orderLines);
  const products = byId(state.products);
  const companies = byId(state.companies);
  const plants = byId(state.plants);
  const parties = byId(state.parties);
  const out: TruckLineFact[] = [];
  for (const t of state.trucks) {
    if (t.tenantId !== tenantId || t.state !== 'dispatched' || t.dispatchedAt === null) continue;
    const order = orders.get(t.orderId);
    const sub = subs.get(t.subOrderId);
    const company = sub ? companies.get(sub.companyId) : undefined;
    if (!order || !sub || !company) continue;
    const plannedByLine = new Map(t.plan.map((p) => [p.orderLineId, p.plannedKg]));
    for (const a of t.allocations) {
      const line = lines.get(a.orderLineId);
      const product = line ? products.get(line.productId) : undefined;
      if (!line || !product) continue;
      out.push({
        truckId: t.id,
        dispatchedAt: t.dispatchedAt,
        companyId: company.id,
        companyCode: company.code,
        companyName: company.name,
        plantId: t.plantId,
        plantName: plants.get(t.plantId)?.name ?? '',
        orderId: order.id,
        orderNumber: order.number,
        subOrderNumber: subOrderNumber(order.number, sub.suffix),
        customerId: order.customerId,
        customerName: order.customerId ? (parties.get(order.customerId)?.name ?? null) : null,
        brokerId: order.brokerId,
        brokerName: order.brokerId ? (parties.get(order.brokerId)?.name ?? null) : null,
        vehicleNo: t.vehicleNo,
        loadingSlipNo: t.loadingSlipNo ?? '',
        productId: product.id,
        productName: productDisplayName(product),
        sizeLabel: product.sizeLabel,
        lengthValue: line.length.value,
        lengthUnit: line.length.unit,
        plannedKg: plannedByLine.get(line.id) ?? 0,
        netKg: a.netKg,
        ratePerMt: line.rate,
        overpricePerMt: line.overpricePerMt,
      });
    }
  }
  return out;
}

function openSubOrders(state: MockState, tenantId: string): OpenSubOrderFact[] {
  const math = orderMath(state);
  const orders = byId(state.orders);
  const companies = byId(state.companies);
  const parties = byId(state.parties);
  const out: OpenSubOrderFact[] = [];
  for (const sub of state.subOrders) {
    const order = orders.get(sub.orderId);
    if (sub.tenantId !== tenantId || !order || isTerminal(math.subOrderStatus(sub))) continue;
    const totals = math.subOrderTotals(sub);
    out.push({
      subOrderId: sub.id,
      orderId: order.id,
      subOrderNumber: subOrderNumber(order.number, sub.suffix),
      companyId: sub.companyId,
      companyCode: companies.get(sub.companyId)?.code ?? '',
      customerId: order.customerId,
      customerName: order.customerId ? (parties.get(order.customerId)?.name ?? null) : null,
      createdAt: order.createdAt,
      orderedKg: totals.orderedKg,
      dispatchedKg: totals.dispatchedKg,
      pendingKg: totals.pendingKg,
    });
  }
  return out;
}

/** One fact per line of every order (drafts live in their own table); a cancelled sub-order books nothing. */
function bookedLines(state: MockState, tenantId: string): BookedLineFact[] {
  const orders = byId(state.orders);
  const subs = byId(state.subOrders);
  const parties = byId(state.parties);
  const out: BookedLineFact[] = [];
  for (const l of state.orderLines) {
    const sub = subs.get(l.subOrderId);
    const order = sub ? orders.get(sub.orderId) : undefined;
    if (l.tenantId !== tenantId || !sub || !order || sub.closeKind === 'cancel') continue;
    out.push({
      orderId: order.id,
      createdAt: order.createdAt,
      companyId: sub.companyId,
      customerId: order.customerId,
      customerName: order.customerId ? (parties.get(order.customerId)?.name ?? null) : null,
      orderedKg: l.orderedKg,
      valueRupees: lineValue(l.orderedKg, billedRate(l.rate, l.overpricePerMt)),
    });
  }
  return out;
}

/** Brokers with at least one ledger row; one without any has nothing to report in any range. */
function brokers(state: MockState, tenantId: string): BrokerFact[] {
  const withRows = new Set(state.brokerLedger.filter((r) => r.tenantId === tenantId).map((r) => r.brokerId));
  return state.parties
    .filter((p) => p.tenantId === tenantId && p.type === 'broker' && withRows.has(p.id))
    .map((p) => ({ brokerId: p.id, brokerName: p.name, rows: brokerFactRows(state, p.id) }));
}

/** Only the facts `kind` reads; the rest stay empty. */
export function reportFacts(state: MockState, tenantId: string, kind: ReportKind): ReportFacts {
  return {
    truckLines: LIFTED.has(kind) ? truckLines(state, tenantId) : [],
    openSubOrders: kind === 'pending-orders' ? openSubOrders(state, tenantId) : [],
    bookedLines: kind === 'customer-wise' ? bookedLines(state, tenantId) : [],
    brokers: kind === 'broker-wise' ? brokers(state, tenantId) : [],
  };
}
