import {
  type Order,
  type OrderLine,
  type OrderStatus,
  type OrderSummary,
  type QtyTotals,
  type SubOrder,
  type TenantSettings,
  orderAgeDays,
  billedRate,
  brokerEarningEstimate,
  isTerminal,
  lineValue,
  orderStatus,
  over,
  overToleranceKg,
  pending,
  productsLabel as sharedProductsLabel,
  subOrderNumber,
  totalsOf,
} from '@tonnage/shared';
import { type GraphMath, type LineRow, type OrderGraph, type SubOrderGraph, graphMath } from './orderGraph.ts';

/** The mock's default when a tenant's settings predate the tolerance setting. */
const DEFAULT_COMPLETION_TOLERANCE_KG = 1000;

/**
 * What every order response needs besides the graph, built once per request: the caller's visible
 * companies (plant heads see only sub-orders of companies owning their plants) and names by id.
 */
export interface OrderViewCtx {
  now: number;
  settings: TenantSettings;
  visibleCompanyIds: ReadonlySet<string>;
  companyById: ReadonlyMap<string, { code: string; name: string }>;
  productById: ReadonlyMap<string, { name: string; category: string; sizeLabel: string }>;
  partyById: ReadonlyMap<string, { id: string; name: string; city: string }>;
  addressById: ReadonlyMap<string, { id: string; partyId: string; label: string; address: string }>;
  userNameById: ReadonlyMap<string, string>;
}

const iso = (d: Date) => d.toISOString();

/** Sub-orders of the order the caller may see, in suffix order. */
export function visibleSubOrders(c: OrderViewCtx, g: OrderGraph): SubOrderGraph[] {
  return g.subOrders.filter((s) => c.visibleCompanyIds.has(s.sub.companyId));
}

const lineValueOf = (l: LineRow) => lineValue(l.orderedKg, billedRate(l.rate, l.overpricePerMt));

/** Days since booking (shared rule). */
export const ageDays = (g: OrderGraph, now: number): number => orderAgeDays(g.order.createdAt.getTime(), now);

/** Status of the order as the caller sees it (only visible sub-orders count). */
function visibleStatus(m: GraphMath, subs: readonly SubOrderGraph[]): OrderStatus {
  return orderStatus({ isDraft: false, subOrders: subs.map((s) => m.subOrderStatus(s)) });
}

function isAged(c: OrderViewCtx, m: GraphMath, subs: readonly SubOrderGraph[], totals: QtyTotals, age: number): boolean {
  return (
    totals.pendingKg > 0 &&
    age > c.settings.agedOrderDays &&
    subs.some((s) => !isTerminal(m.subOrderStatus(s)))
  );
}

const totalsOfSubs = (m: GraphMath, subs: readonly SubOrderGraph[]): QtyTotals =>
  totalsOf(subs.flatMap((s) => s.lines.map(m.lineQty)));

const userRef = (c: OrderViewCtx, id: string) => ({ id, name: c.userNameById.get(id) ?? '' });

function toLine(c: OrderViewCtx, m: GraphMath, l: LineRow): OrderLine {
  const q = m.lineQty(l);
  return {
    id: l.id,
    productId: l.productId,
    productName: c.productById.get(l.productId)?.name ?? '',
    length: { ...l.length },
    orderedKg: q.orderedKg,
    dispatchedKg: q.dispatchedKg,
    closedKg: q.closedKg,
    reservedKg: q.reservedKg,
    pendingKg: pending(q),
    overKg: over(q),
    rate: l.rate,
    rateEdited: l.rateEdited,
    basicRateSnapshot: l.basicRateSnapshot,
    conversionSnapshot: l.conversionSnapshot,
    overpricePerMt: l.overpricePerMt,
    lineValue: lineValueOf(l),
    version: l.version,
  };
}

function toSubOrder(c: OrderViewCtx, m: GraphMath, g: OrderGraph, s: SubOrderGraph): SubOrder {
  const company = c.companyById.get(s.sub.companyId);
  return {
    id: s.sub.id,
    number: subOrderNumber(g.order.number, s.sub.suffix),
    suffix: s.sub.suffix,
    companyId: s.sub.companyId,
    companyCode: company?.code ?? '',
    companyName: company?.name ?? '',
    status: m.subOrderStatus(s),
    closeKind: s.sub.closeKind,
    closeReason: s.sub.closeReason,
    closeNote: s.sub.closeNote,
    closedAt: s.sub.closedAt === null ? null : iso(s.sub.closedAt),
    closedBy: s.sub.closedBy === null ? null : userRef(c, s.sub.closedBy),
    lines: s.lines.map((l) => toLine(c, m, l)),
    totals: m.subOrderTotals(s),
    openTrucks: m.openTrucksOf(s),
    overToleranceKg: overToleranceKg(
      s.lines.map(m.lineQty),
      c.settings.completionToleranceKg ?? DEFAULT_COMPLETION_TOLERANCE_KG,
    ),
    dispatchedTrucks: s.trucks.filter((t) => t.truck.state === 'dispatched').length,
    valueRupees: s.lines.reduce((sum, l) => sum + lineValueOf(l), 0),
    version: s.sub.version,
  };
}

function partyRef(c: OrderViewCtx, id: string | null) {
  const p = id === null ? undefined : c.partyById.get(id);
  return p ? { id: p.id, name: p.name, city: p.city } : null;
}

/** An address of the order's customer (as the mock looks it up: among that party's addresses). */
function addressRef(c: OrderViewCtx, partyId: string | null, addressId: string | null) {
  const a = addressId === null ? undefined : c.addressById.get(addressId);
  return a && partyId !== null && a.partyId === partyId ? { id: a.id, label: a.label, address: a.address } : null;
}

/** The full order as `orderSchema`; the caller must see at least one sub-order (else 404 earlier). */
export function toOrder(g: OrderGraph, c: OrderViewCtx): Order {
  const m = graphMath(g);
  const o = g.order;
  const subs = visibleSubOrders(c, g);
  const lines = subs.flatMap((s) => s.lines);
  const totals = totalsOfSubs(m, subs);
  const age = ageDays(g, c.now);
  return {
    id: o.id,
    number: o.number,
    status: visibleStatus(m, subs),
    type: o.type,
    customer: partyRef(c, o.customerId),
    broker: partyRef(c, o.brokerId),
    commissionPerMtSnapshot: o.commissionPerMtSnapshot,
    billTo: addressRef(c, o.customerId, o.billToId),
    shipTo: addressRef(c, o.customerId, o.shipToId),
    pricingMethod: o.pricingMethod,
    basicRate: o.basicRate,
    notify: { customer: o.notifyCustomer, broker: o.notifyBroker },
    subOrders: subs.map((s) => toSubOrder(c, m, g, s)),
    // Ruling 1: vehicle requests move to B3 (their open/closed rule needs truck assignment).
    vehicleRequests: [],
    totals,
    estimatedValue: lines.reduce((sum, l) => sum + lineValueOf(l), 0),
    ...(o.brokerId !== null
      ? { brokerEarningEstimate: brokerEarningEstimate(lines, o.commissionPerMtSnapshot ?? 0) }
      : {}),
    ageDays: age,
    isAged: isAged(c, m, subs, totals, age),
    createdAt: iso(o.createdAt),
    createdBy: userRef(c, o.createdBy),
    version: o.version,
  };
}

/** "TMT 12, 16 mm", "MS Billet", "TMT 16 mm · Angle": sizes in mm are merged per category. */
export function productsLabel(c: OrderViewCtx, lines: readonly LineRow[]): string {
  return sharedProductsLabel(lines.flatMap((l) => c.productById.get(l.productId) ?? []));
}

/** A list row; with a company filter the figures (and status) cover that company's sub-order only. */
export function toOrderSummary(g: OrderGraph, c: OrderViewCtx, companyId?: string): OrderSummary {
  const m = graphMath(g);
  const o = g.order;
  const subs = visibleSubOrders(c, g).filter((s) => companyId === undefined || s.sub.companyId === companyId);
  const lines = subs.flatMap((s) => s.lines);
  const totals = totalsOfSubs(m, subs);
  const age = ageDays(g, c.now);
  const customer = partyRef(c, o.customerId);
  return {
    id: o.id,
    number: o.number,
    status: visibleStatus(m, subs),
    type: o.type,
    customerName: customer?.name ?? null,
    customerCity: customer?.city ?? null,
    brokerName: partyRef(c, o.brokerId)?.name ?? null,
    companyCodes: subs.map((s) => c.companyById.get(s.sub.companyId)?.code ?? ''),
    productsLabel: productsLabel(c, lines),
    totals,
    estimatedValue: lines.reduce((sum, l) => sum + lineValueOf(l), 0),
    createdAt: iso(o.createdAt),
    ageDays: age,
    isAged: isAged(c, m, subs, totals, age),
  };
}
