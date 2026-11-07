import {
  type Order,
  type OrderStatus,
  type OrderSummary,
  type QtyTotals,
  type SubOrder,
  billedRate,
  brokerEarningEstimate,
  isTerminal,
  lineValue,
  orderStatus,
  pending,
  over,
  productDisplayName,
  subOrderNumber,
  totalsOf,
} from '@tonnage/shared';
import { DAY, fromIso } from './clock.ts';
import { notFound } from './errors.ts';
import type { OrderMath } from './orders-math.ts';
import type { MockState, OrderLineRec, OrderRec, SubOrderRec } from './store.ts';
import { type Authed, visibleCompanies } from './views.ts';

/**
 * Everything an order response needs, built once per request: lookups by id and the set of
 * companies the caller may see (plant heads see only sub-orders of companies owning their plants).
 */
export interface OrderCtx {
  state: MockState;
  math: OrderMath;
  a: Authed;
  now: number;
  visibleCompanyIds: ReadonlySet<string>;
  companyById: Map<string, { code: string; name: string }>;
  productNameById: Map<string, { name: string; category: string; sizeLabel: string }>;
  partyById: Map<string, { id: string; name: string; city: string; addresses: { id: string; label: string; address: string }[] }>;
  userNameById: Map<string, string>;
}

export function orderCtx(state: MockState, math: OrderMath, a: Authed, now: number): OrderCtx {
  const tenantId = a.user.tenantId;
  return {
    state,
    math,
    a,
    now,
    visibleCompanyIds: new Set(visibleCompanies(state, a).map((c) => c.id)),
    companyById: new Map(state.companies.filter((c) => c.tenantId === tenantId).map((c) => [c.id, c])),
    productNameById: new Map(
      state.products
        .filter((p) => p.tenantId === tenantId)
        .map((p) => [p.id, { name: productDisplayName(p), category: p.category, sizeLabel: p.sizeLabel }]),
    ),
    partyById: new Map(state.parties.filter((p) => p.tenantId === tenantId).map((p) => [p.id, p])),
    userNameById: new Map(state.users.filter((u) => u.tenantId === tenantId).map((u) => [u.id, u.name])),
  };
}

/** Sub-orders of an order the caller may see, in suffix order. */
export function visibleSubOrders(c: OrderCtx, order: OrderRec): SubOrderRec[] {
  return c.math.subOrdersOf(order.id).filter((s) => c.visibleCompanyIds.has(s.companyId));
}

/** Order by id within tenant and scope; 404 when missing or when no sub-order is visible. */
export function findOrder(c: OrderCtx, id: string | undefined): OrderRec {
  const o = c.state.orders.find((x) => x.id === id && x.tenantId === c.a.user.tenantId);
  if (!o || visibleSubOrders(c, o).length === 0) throw notFound();
  return o;
}

const lineValueOf = (l: OrderLineRec) => lineValue(l.orderedKg, billedRate(l.rate, l.overpricePerMt));

/** Days since booking, by elapsed time (the aged badge counts full days). */
export function ageDays(order: OrderRec, now: number): number {
  return Math.max(0, Math.floor((now - fromIso(order.createdAt)) / DAY));
}

/** Status of the order as the caller sees it (only visible sub-orders count). */
export function visibleStatus(c: OrderCtx, subs: readonly SubOrderRec[]): OrderStatus {
  return orderStatus({ isDraft: false, subOrders: subs.map((s) => c.math.subOrderStatus(s)) });
}

function isAged(c: OrderCtx, subs: readonly SubOrderRec[], totals: QtyTotals, age: number): boolean {
  const tenant = c.a.tenant;
  return (
    totals.pendingKg > 0 &&
    age > tenant.settings.agedOrderDays &&
    subs.some((s) => !isTerminal(c.math.subOrderStatus(s)))
  );
}

function totalsOfSubs(c: OrderCtx, subs: readonly SubOrderRec[]): QtyTotals {
  return totalsOf(subs.flatMap((s) => c.math.linesOf(s.id).map(c.math.lineQty)));
}

function toSubOrder(c: OrderCtx, order: OrderRec, s: SubOrderRec): SubOrder {
  const lines = c.math.linesOf(s.id);
  const company = c.companyById.get(s.companyId);
  return {
    id: s.id,
    number: subOrderNumber(order.number, s.suffix),
    suffix: s.suffix,
    companyId: s.companyId,
    companyCode: company?.code ?? '',
    companyName: company?.name ?? '',
    status: c.math.subOrderStatus(s),
    closeKind: s.closeKind,
    closeReason: s.closeReason,
    closeNote: s.closeNote,
    closedAt: s.closedAt,
    closedBy: s.closedBy ? { id: s.closedBy, name: c.userNameById.get(s.closedBy) ?? '' } : null,
    lines: lines.map((l) => {
      const q = c.math.lineQty(l);
      return {
        id: l.id,
        productId: l.productId,
        productName: c.productNameById.get(l.productId)?.name ?? '',
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
    }),
    totals: c.math.subOrderTotals(s),
    openTrucks: c.math.openTrucksOf(s.id),
    dispatchedTrucks: c.math.trucksOf(s.id).filter((t) => t.state === 'dispatched').length,
    valueRupees: lines.reduce((sum, l) => sum + lineValueOf(l), 0),
    version: s.version,
  };
}

function partyRef(c: OrderCtx, id: string | null) {
  const p = id ? c.partyById.get(id) : undefined;
  return p ? { id: p.id, name: p.name, city: p.city } : null;
}

function addressRef(c: OrderCtx, partyId: string | null, addressId: string | null) {
  const a = partyId && addressId ? c.partyById.get(partyId)?.addresses.find((x) => x.id === addressId) : undefined;
  return a ? { id: a.id, label: a.label, address: a.address } : null;
}

export function toOrder(c: OrderCtx, order: OrderRec): Order {
  const subs = visibleSubOrders(c, order);
  const lines = subs.flatMap((s) => c.math.linesOf(s.id));
  const totals = totalsOfSubs(c, subs);
  const age = ageDays(order, c.now);
  return {
    id: order.id,
    number: order.number,
    status: visibleStatus(c, subs),
    type: order.type,
    customer: partyRef(c, order.customerId),
    broker: partyRef(c, order.brokerId),
    commissionPerMtSnapshot: order.commissionPerMtSnapshot,
    billTo: addressRef(c, order.customerId, order.billToId),
    shipTo: addressRef(c, order.customerId, order.shipToId),
    pricingMethod: order.pricingMethod,
    basicRate: order.basicRate,
    notify: { ...order.notify },
    subOrders: subs.map((s) => toSubOrder(c, order, s)),
    totals,
    estimatedValue: lines.reduce((sum, l) => sum + lineValueOf(l), 0),
    ...(order.brokerId !== null
      ? { brokerEarningEstimate: brokerEarningEstimate(lines, order.commissionPerMtSnapshot ?? 0) }
      : {}),
    ageDays: age,
    isAged: isAged(c, subs, totals, age),
    createdAt: order.createdAt,
    createdBy: { id: order.createdBy, name: c.userNameById.get(order.createdBy) ?? '' },
    version: order.version,
  };
}

/** "TMT 12, 16 mm", "MS Billet", "TMT 16 mm · Angle": sizes in mm are merged per category. */
export function productsLabel(c: OrderCtx, lines: readonly OrderLineRec[]): string {
  const byCategory = new Map<string, string[]>();
  for (const l of lines) {
    const p = c.productNameById.get(l.productId);
    if (!p) continue;
    const sizes = byCategory.get(p.category) ?? [];
    if (!sizes.includes(p.sizeLabel)) sizes.push(p.sizeLabel);
    byCategory.set(p.category, sizes);
  }
  const collator = new Intl.Collator('en', { numeric: true });
  return [...byCategory.entries()]
    .map(([category, sizes]) => {
      if (sizes.every((s) => /^\d+(\.\d+)?\s*mm$/.test(s))) {
        const nums = sizes.map((s) => s.replace(/\s*mm$/, '')).sort(collator.compare);
        return `${category} ${nums.join(', ')} mm`;
      }
      return category;
    })
    .join(' · ');
}

/** List row; with a company filter the figures cover that company's sub-order only. */
export function toSummary(c: OrderCtx, order: OrderRec, companyId?: string): OrderSummary {
  const subs = visibleSubOrders(c, order).filter((s) => companyId === undefined || s.companyId === companyId);
  const lines = subs.flatMap((s) => c.math.linesOf(s.id));
  const totals = totalsOfSubs(c, subs);
  const age = ageDays(order, c.now);
  const customer = partyRef(c, order.customerId);
  return {
    id: order.id,
    number: order.number,
    status: visibleStatus(c, subs),
    type: order.type,
    customerName: customer?.name ?? null,
    customerCity: customer?.city ?? null,
    brokerName: partyRef(c, order.brokerId)?.name ?? null,
    companyCodes: subs.map((s) => c.companyById.get(s.companyId)?.code ?? ''),
    productsLabel: productsLabel(c, lines),
    totals,
    estimatedValue: lines.reduce((sum, l) => sum + lineValueOf(l), 0),
    createdAt: order.createdAt,
    ageDays: age,
    isAged: isAged(c, subs, totals, age),
  };
}
