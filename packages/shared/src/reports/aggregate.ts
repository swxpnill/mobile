import { billedRate, roundHalfUp, roundHalfUpSigned } from '../rules/money.ts';
import { statementTotals } from '../rules/ledger.ts';
import { ageBucket, ageBucketLabels, ageDays, inRange, istDate, type AgeBucket } from './dates.ts';
import {
  REPORT_ROW_CAP,
  type ReportFacts,
  type ReportFilter,
  type ReportKind,
  type TruckLineFact,
} from './facts.ts';

/** Percent of plan in tenths: `diff x 1000 / planned`, rounded once; null with no plan. */
export function variancePercentTenths(diffKg: number, plannedKg: number): number | null {
  if (plannedKg === 0) return null;
  return roundHalfUpSigned(diffKg * 1000, plannedKg);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Base<K extends ReportKind> {
  kind: K;
  from: string;
  to: string;
  truncated: boolean;
}

function cap<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > REPORT_ROW_CAP
    ? { rows: rows.slice(0, REPORT_ROW_CAP), truncated: true }
    : { rows, truncated: false };
}

/** One truck line's rupees at the billed rate, rounded once. Every lifted value is a sum of these. */
export function lineValueRupees(l: Pick<TruckLineFact, 'netKg' | 'ratePerMt' | 'overpricePerMt'>): number {
  return roundHalfUp(l.netKg * billedRate(l.ratePerMt, l.overpricePerMt), 1000);
}

function liftedLines(facts: ReportFacts, f: ReportFilter): TruckLineFact[] {
  return facts.truckLines.filter(
    (l) => inRange(istDate(l.dispatchedAt), f.from, f.to) && (!f.companyId || l.companyId === f.companyId),
  );
}

function companySummary(lines: TruckLineFact[]) {
  const m = new Map<
    string,
    { companyId: string; companyCode: string; companyName: string; netKg: number; trucks: Set<string> }
  >();
  for (const l of lines) {
    const e = m.get(l.companyId) ?? {
      companyId: l.companyId,
      companyCode: l.companyCode,
      companyName: l.companyName,
      netKg: 0,
      trucks: new Set<string>(),
    };
    e.netKg += l.netKg;
    e.trucks.add(l.truckId);
    m.set(l.companyId, e);
  }
  return [...m.values()]
    .sort((a, b) => cmp(a.companyCode, b.companyCode))
    .map(({ trucks, ...rest }) => ({ ...rest, trucks: trucks.size }));
}

export interface DispatchRegisterRow {
  truckId: string;
  date: string;
  companyCode: string;
  orderNumber: string;
  subOrderNumber: string;
  customerName: string | null;
  brokerName: string | null;
  vehicleNo: string;
  loadingSlipNo: string;
  productName: string;
  lengthValue: number | null;
  lengthUnit: string | null;
  netKg: number;
  billedRate: number;
  valueRupees: number;
}
export interface DispatchRegisterReport extends Base<'dispatch-register'> {
  rows: DispatchRegisterRow[];
  summary: {
    netKg: number;
    trucks: number;
    overUnderKg: number;
    valueRupees: number;
    byCompany: { companyId: string; companyCode: string; companyName: string; netKg: number; trucks: number }[];
  };
}

export function dispatchRegister(facts: ReportFacts, f: ReportFilter): DispatchRegisterReport {
  const lines = liftedLines(facts, f).filter(
    (l) => (!f.customerId || l.customerId === f.customerId) && (!f.brokerId || l.brokerId === f.brokerId),
  );
  const all: DispatchRegisterRow[] = lines
    .map((l) => {
      return {
        truckId: l.truckId,
        date: istDate(l.dispatchedAt),
        companyCode: l.companyCode,
        orderNumber: l.orderNumber,
        subOrderNumber: l.subOrderNumber,
        customerName: l.customerName,
        brokerName: l.brokerName,
        vehicleNo: l.vehicleNo,
        loadingSlipNo: l.loadingSlipNo,
        productName: l.productName,
        lengthValue: l.lengthValue,
        lengthUnit: l.lengthUnit,
        netKg: l.netKg,
        billedRate: billedRate(l.ratePerMt, l.overpricePerMt),
        valueRupees: lineValueRupees(l),
      };
    })
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.loadingSlipNo, b.loadingSlipNo));
  return {
    kind: 'dispatch-register',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: {
      netKg: lines.reduce((s, l) => s + l.netKg, 0),
      trucks: new Set(lines.map((l) => l.truckId)).size,
      overUnderKg: lines.reduce((s, l) => s + l.netKg - l.plannedKg, 0),
      valueRupees: all.reduce((s, r) => s + r.valueRupees, 0),
      byCompany: companySummary(lines),
    },
  };
}

export interface PendingOrderRow {
  subOrderId: string;
  orderId: string;
  subOrderNumber: string;
  companyCode: string;
  customerName: string | null;
  createdAt: string;
  ageDays: number;
  bucket: AgeBucket;
  orderedKg: number;
  dispatchedKg: number;
  pendingKg: number;
}
export interface PendingOrdersReport extends Base<'pending-orders'> {
  rows: PendingOrderRow[];
  summary: { pendingKg: number; subOrders: number; byBucket: { bucket: AgeBucket; pendingKg: number; count: number }[] };
}

/** "As of now": the date range is ignored. */
export function pendingOrders(facts: ReportFacts, f: ReportFilter): PendingOrdersReport {
  const unfiltered: PendingOrderRow[] = facts.openSubOrders
    .filter((s) => s.pendingKg > 0 && (!f.companyId || s.companyId === f.companyId))
    .map((s) => {
      const age = ageDays(s.createdAt, f.today);
      return {
        subOrderId: s.subOrderId,
        orderId: s.orderId,
        subOrderNumber: s.subOrderNumber,
        companyCode: s.companyCode,
        customerName: s.customerName,
        createdAt: s.createdAt,
        ageDays: age,
        bucket: ageBucket(age, f.agedOrderDays),
        orderedKg: s.orderedKg,
        dispatchedKg: s.dispatchedKg,
        pendingKg: s.pendingKg,
      };
    })
    .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.subOrderNumber, b.subOrderNumber));
  const all = unfiltered.filter((r) => !f.bucket || r.bucket === f.bucket);
  return {
    kind: 'pending-orders',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: {
      pendingKg: all.reduce((s, r) => s + r.pendingKg, 0),
      subOrders: all.length,
      // Counted before the bucket filter so the chips keep their numbers.
      byBucket: ageBucketLabels(f.agedOrderDays).map((bucket) => {
        const inB = unfiltered.filter((r) => r.bucket === bucket);
        return { bucket, pendingKg: inB.reduce((s, r) => s + r.pendingKg, 0), count: inB.length };
      }),
    },
  };
}

export interface UnitSalesRow {
  companyId: string;
  companyCode: string;
  companyName: string;
  productId: string;
  productName: string;
  netKg: number;
  valueRupees: number;
  trucks: number;
}
export interface UnitSalesReport extends Base<'unit-sales'> {
  rows: UnitSalesRow[];
  summary: {
    netKg: number;
    valueRupees: number;
    byCompany: {
      companyId: string;
      companyCode: string;
      companyName: string;
      netKg: number;
      valueRupees: number;
      trucks: number;
    }[];
  };
}

export function unitSales(facts: ReportFacts, f: ReportFilter): UnitSalesReport {
  const lines = liftedLines(facts, f);
  const m = new Map<string, { l: TruckLineFact; netKg: number; value: number; trucks: Set<string> }>();
  for (const l of lines) {
    const k = `${l.companyId}|${l.productId}`;
    const e = m.get(k) ?? { l, netKg: 0, value: 0, trucks: new Set<string>() };
    e.netKg += l.netKg;
    e.value += lineValueRupees(l);
    e.trucks.add(l.truckId);
    m.set(k, e);
  }
  const all: UnitSalesRow[] = [...m.values()]
    .map((e) => ({
      companyId: e.l.companyId,
      companyCode: e.l.companyCode,
      companyName: e.l.companyName,
      productId: e.l.productId,
      productName: e.l.productName,
      netKg: e.netKg,
      valueRupees: e.value,
      trucks: e.trucks.size,
    }))
    .sort((a, b) => cmp(a.companyCode, b.companyCode) || cmp(a.productName, b.productName));
  const byCompany = new Map<string, UnitSalesReport['summary']['byCompany'][number]>();
  for (const r of all) {
    const e = byCompany.get(r.companyId) ?? {
      companyId: r.companyId,
      companyCode: r.companyCode,
      companyName: r.companyName,
      netKg: 0,
      valueRupees: 0,
      trucks: 0,
    };
    e.netKg += r.netKg;
    e.valueRupees += r.valueRupees;
    byCompany.set(r.companyId, e);
  }
  for (const e of byCompany.values()) {
    e.trucks = new Set(lines.filter((l) => l.companyId === e.companyId).map((l) => l.truckId)).size;
  }
  return {
    kind: 'unit-sales',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: {
      netKg: all.reduce((s, r) => s + r.netKg, 0),
      valueRupees: all.reduce((s, r) => s + r.valueRupees, 0),
      byCompany: [...byCompany.values()].sort((a, b) => cmp(a.companyCode, b.companyCode)),
    },
  };
}

export interface BrokerWiseRow {
  brokerId: string;
  brokerName: string;
  netKg: number;
  commissionRupees: number;
  overpriceRupees: number;
  earnedRupees: number;
  paidRupees: number;
  dueRupees: number;
}
export interface BrokerWiseReport extends Base<'broker-wise'> {
  rows: BrokerWiseRow[];
  summary: Omit<BrokerWiseRow, 'brokerId' | 'brokerName'>;
}

export function brokerWise(facts: ReportFacts, f: ReportFilter): BrokerWiseReport {
  const all: BrokerWiseRow[] = [];
  for (const b of facts.brokers) {
    if (f.brokerId && b.brokerId !== f.brokerId) continue;
    const t = statementTotals(b.rows, f.from, f.to);
    if (t.inRange.length === 0 && t.closingDueRupees === 0) continue;
    const inRows = b.rows.filter((r) => inRange(r.entryDate, f.from, f.to));
    // A reversal's earningLines carry negated netKg, so summing every in-range row nets corrections.
    const commissionRupees = roundHalfUpSigned(
      inRows.reduce((s, r) => s + r.earningLines.reduce((x, e) => x + e.netKg * e.commissionPerMt, 0), 0),
      1000,
    );
    all.push({
      brokerId: b.brokerId,
      brokerName: b.brokerName,
      netKg: inRows.reduce((s, r) => s + r.netKg, 0),
      commissionRupees,
      overpriceRupees: t.earnedRupees - commissionRupees,
      earnedRupees: t.earnedRupees,
      paidRupees: t.paidRupees,
      dueRupees: t.closingDueRupees,
    });
  }
  all.sort((a, b) => b.dueRupees - a.dueRupees || cmp(a.brokerName, b.brokerName));
  const sum = (k: keyof Omit<BrokerWiseRow, 'brokerId' | 'brokerName'>) => all.reduce((s, r) => s + r[k], 0);
  return {
    kind: 'broker-wise',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: {
      netKg: sum('netKg'),
      commissionRupees: sum('commissionRupees'),
      overpriceRupees: sum('overpriceRupees'),
      earnedRupees: sum('earnedRupees'),
      paidRupees: sum('paidRupees'),
      dueRupees: sum('dueRupees'),
    },
  };
}

export interface CustomerWiseRow {
  customerId: string | null;
  customerName: string | null;
  bookedKg: number;
  bookedValueRupees: number;
  liftedKg: number;
  liftedValueRupees: number;
}
export interface CustomerWiseReport extends Base<'customer-wise'> {
  rows: CustomerWiseRow[];
  summary: { bookedKg: number; bookedValueRupees: number; liftedKg: number; liftedValueRupees: number };
}

export function customerWise(facts: ReportFacts, f: ReportFilter): CustomerWiseReport {
  const m = new Map<
    string,
    { id: string | null; name: string | null; bookedKg: number; bookedValue: number; liftedKg: number; liftedValue: number }
  >();
  const entry = (id: string | null, name: string | null) => {
    const k = id ?? '';
    const e = m.get(k) ?? { id, name, bookedKg: 0, bookedValue: 0, liftedKg: 0, liftedValue: 0 };
    m.set(k, e);
    return e;
  };
  for (const b of facts.bookedLines) {
    if (!inRange(istDate(b.createdAt), f.from, f.to)) continue;
    if (f.companyId && b.companyId !== f.companyId) continue;
    if (f.customerId && b.customerId !== f.customerId) continue;
    const e = entry(b.customerId, b.customerName);
    e.bookedKg += b.orderedKg;
    e.bookedValue += b.valueRupees;
  }
  for (const l of liftedLines(facts, f)) {
    if (f.customerId && l.customerId !== f.customerId) continue;
    const e = entry(l.customerId, l.customerName);
    e.liftedKg += l.netKg;
    e.liftedValue += lineValueRupees(l);
  }
  const all: CustomerWiseRow[] = [...m.values()]
    .map((e) => ({
      customerId: e.id,
      customerName: e.name,
      bookedKg: e.bookedKg,
      bookedValueRupees: e.bookedValue,
      liftedKg: e.liftedKg,
      liftedValueRupees: e.liftedValue,
    }))
    .sort((a, b) => b.liftedKg - a.liftedKg || cmp(a.customerName ?? '', b.customerName ?? ''));
  const sum = (k: 'bookedKg' | 'bookedValueRupees' | 'liftedKg' | 'liftedValueRupees') =>
    all.reduce((s, r) => s + r[k], 0);
  return {
    kind: 'customer-wise',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: {
      bookedKg: sum('bookedKg'),
      bookedValueRupees: sum('bookedValueRupees'),
      liftedKg: sum('liftedKg'),
      liftedValueRupees: sum('liftedValueRupees'),
    },
  };
}

export interface ProductWiseRow {
  productId: string;
  productName: string;
  sizeLabel: string;
  lengthValue: number | null;
  lengthUnit: string | null;
  netKg: number;
  trucks: number;
}
export interface ProductWiseReport extends Base<'product-wise'> {
  rows: ProductWiseRow[];
  summary: { netKg: number; trucks: number };
}

export function productWise(facts: ReportFacts, f: ReportFilter): ProductWiseReport {
  const lines = liftedLines(facts, f);
  const m = new Map<string, { l: TruckLineFact; netKg: number; trucks: Set<string> }>();
  for (const l of lines) {
    const k = `${l.productId}|${l.sizeLabel}|${l.lengthValue ?? ''}|${l.lengthUnit ?? ''}`;
    const e = m.get(k) ?? { l, netKg: 0, trucks: new Set<string>() };
    e.netKg += l.netKg;
    e.trucks.add(l.truckId);
    m.set(k, e);
  }
  const all: ProductWiseRow[] = [...m.values()]
    .map((e) => ({
      productId: e.l.productId,
      productName: e.l.productName,
      sizeLabel: e.l.sizeLabel,
      lengthValue: e.l.lengthValue,
      lengthUnit: e.l.lengthUnit,
      netKg: e.netKg,
      trucks: e.trucks.size,
    }))
    .sort((a, b) => b.netKg - a.netKg || cmp(a.productName, b.productName) || cmp(a.sizeLabel, b.sizeLabel));
  return {
    kind: 'product-wise',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: { netKg: lines.reduce((s, l) => s + l.netKg, 0), trucks: new Set(lines.map((l) => l.truckId)).size },
  };
}

export interface LoadingVarianceRow {
  truckId: string;
  date: string;
  plantName: string;
  vehicleNo: string;
  subOrderNumber: string;
  plannedKg: number;
  netKg: number;
  diffKg: number;
}
export interface LoadingVarianceReport extends Base<'loading-variance'> {
  rows: LoadingVarianceRow[];
  /** `overKg` and `underKg` are both positive magnitudes. */
  summary: { trucks: number; overTrucks: number; underTrucks: number; overKg: number; underKg: number };
}

export function loadingVariance(facts: ReportFacts, f: ReportFilter): LoadingVarianceReport {
  const m = new Map<string, LoadingVarianceRow>();
  for (const l of facts.truckLines) {
    const date = istDate(l.dispatchedAt);
    if (!inRange(date, f.from, f.to)) continue;
    if (f.plantId && l.plantId !== f.plantId) continue;
    const e = m.get(l.truckId) ?? {
      truckId: l.truckId,
      date,
      plantName: l.plantName,
      vehicleNo: l.vehicleNo,
      subOrderNumber: l.subOrderNumber,
      plannedKg: 0,
      netKg: 0,
      diffKg: 0,
    };
    e.plannedKg += l.plannedKg;
    e.netKg += l.netKg;
    e.diffKg = e.netKg - e.plannedKg;
    m.set(l.truckId, e);
  }
  const all = [...m.values()].sort(
    (a, b) => cmp(a.date, b.date) || cmp(a.vehicleNo, b.vehicleNo) || cmp(a.truckId, b.truckId),
  );
  return {
    kind: 'loading-variance',
    from: f.from,
    to: f.to,
    ...cap(all),
    summary: {
      trucks: all.length,
      overTrucks: all.filter((r) => r.diffKg > 0).length,
      underTrucks: all.filter((r) => r.diffKg < 0).length,
      overKg: all.filter((r) => r.diffKg > 0).reduce((s, r) => s + r.diffKg, 0),
      underKg: all.filter((r) => r.diffKg < 0).reduce((s, r) => s - r.diffKg, 0),
    },
  };
}

export interface ReportByKind {
  'dispatch-register': DispatchRegisterReport;
  'pending-orders': PendingOrdersReport;
  'unit-sales': UnitSalesReport;
  'broker-wise': BrokerWiseReport;
  'customer-wise': CustomerWiseReport;
  'product-wise': ProductWiseReport;
  'loading-variance': LoadingVarianceReport;
}
export type ReportOf<K extends ReportKind> = ReportByKind[K];
export type Report = ReportByKind[ReportKind];

export function buildReport(kind: ReportKind, facts: ReportFacts, f: ReportFilter): Report {
  switch (kind) {
    case 'dispatch-register':
      return dispatchRegister(facts, f);
    case 'pending-orders':
      return pendingOrders(facts, f);
    case 'unit-sales':
      return unitSales(facts, f);
    case 'broker-wise':
      return brokerWise(facts, f);
    case 'customer-wise':
      return customerWise(facts, f);
    case 'product-wise':
      return productWise(facts, f);
    case 'loading-variance':
      return loadingVariance(facts, f);
  }
}
