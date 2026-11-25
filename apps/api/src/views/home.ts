import {
  type Home,
  type PlantScope,
  type TenantSettings,
  billedRate,
  isOpenTruckState,
  isTerminal,
  istDayStart,
  istWeekStart,
  lineValue,
} from '@tonnage/shared';
import { graphMath, truckNetKg, type OrderGraph, type TruckGraph } from './orderGraph.ts';
import { ageDays } from './orders.ts';

const DAY = 24 * 60 * 60 * 1000;

/** What `toHome` reads besides the graphs: the visible companies and plants, the unit filter, the settings. */
export interface HomeInput {
  now: number;
  settings: TenantSettings;
  scope: PlantScope;
  /** The companies the caller may see. */
  companies: readonly { id: string; code: string; name: string }[];
  /** The unit switcher's company, when one is chosen (already checked to be visible). */
  companyId: string | undefined;
}

/** Board order: awaiting approval first, then loading, arrived, assigned; ties by assignment time, then id. */
const STATE_RANK: Readonly<Record<string, number>> = { weighed: 0, loading: 1, at_gate: 2, assigned: 3, dispatched: 4 };

function boardOrder(x: TruckGraph, y: TruckGraph): number {
  const a = x.truck;
  const b = y.truck;
  const r = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
  if (r !== 0) return r;
  if (a.assignedAt.getTime() !== b.assignedAt.getTime()) return a.assignedAt.getTime() < b.assignedAt.getTime() ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The Home figures (mock `GET /v1/home`) over the order graphs of the caller's companies, by the
 * shared rules: pending per company, orders booked and trucks dispatched since IST midnight, the
 * week against the week before, and the trucks open at the caller's plants. `valueRupees` is
 * stripped by the pipeline for roles without money.
 */
export function toHome(graphs: Iterable<OrderGraph>, input: HomeInput): Home {
  const { now, settings, scope, companyId } = input;
  const visibleIds = new Set(input.companies.map((c) => c.id));
  const inFilter = (id: string) => companyId === undefined || id === companyId;
  const today = istDayStart(now);
  const week = istWeekStart(now);
  const lastWeek = week - 7 * DAY;
  const pendingByCompany = new Map<string, number>();
  const companyCode = new Map(input.companies.map((c) => [c.id, c.code]));
  const inPlant: { t: TruckGraph; companyId: string }[] = [];
  const home: Home = {
    pendingKg: 0,
    openOrders: 0,
    unitCount: 0,
    perCompany: [],
    agedOrders: 0,
    agedOrderDays: settings.agedOrderDays,
    bookedToday: { kg: 0, orders: 0, valueRupees: 0 },
    dispatchedToday: { kg: 0, trucks: 0 },
    sentThisWeek: { kg: 0, changePct: null },
    inPlant: [],
  };
  let lastWeekKg = 0;

  for (const g of graphs) {
    const subs = g.subOrders.filter((s) => visibleIds.has(s.sub.companyId) && inFilter(s.sub.companyId));
    if (subs.length === 0) continue;
    const m = graphMath(g);
    let orderPending = 0;
    let open = false;
    for (const s of subs) {
      if (!isTerminal(m.subOrderStatus(s))) {
        open = true;
        const p = m.subOrderTotals(s).pendingKg;
        orderPending += p;
        pendingByCompany.set(s.sub.companyId, (pendingByCompany.get(s.sub.companyId) ?? 0) + p);
      }
      for (const t of s.trucks) {
        const { truck } = t;
        if (isOpenTruckState(truck.state) && (scope.kind === 'all' || scope.plantIds.includes(truck.plantId))) {
          inPlant.push({ t, companyId: s.sub.companyId });
        }
        if (truck.state !== 'dispatched' || truck.dispatchedAt === null) continue;
        const at = truck.dispatchedAt.getTime();
        const net = truckNetKg(t);
        if (at >= today) {
          home.dispatchedToday.kg += net;
          home.dispatchedToday.trucks += 1;
        }
        if (at >= week) home.sentThisWeek.kg += net;
        else if (at >= lastWeek) lastWeekKg += net;
      }
    }
    if (open) {
      home.openOrders += 1;
      home.pendingKg += orderPending;
      if (orderPending > 0 && ageDays(g, now) > settings.agedOrderDays) home.agedOrders += 1;
    }
    if (g.order.createdAt.getTime() >= today) {
      const lines = subs.flatMap((s) => s.lines);
      home.bookedToday.orders += 1;
      home.bookedToday.kg += lines.reduce((sum, l) => sum + l.orderedKg, 0);
      home.bookedToday.valueRupees =
        (home.bookedToday.valueRupees ?? 0) +
        lines.reduce((sum, l) => sum + lineValue(l.orderedKg, billedRate(l.rate, l.overpricePerMt)), 0);
    }
  }

  home.inPlant = inPlant
    .sort((x, y) => boardOrder(x.t, y.t))
    .map(({ t, companyId: cid }) => ({
      truckId: t.truck.id,
      vehicleNo: t.truck.vehicleNo,
      companyCode: companyCode.get(cid) ?? '',
      state: t.truck.state as Home['inPlant'][number]['state'],
      plannedKg: t.plan.reduce((sum, p) => sum + p.plannedKg, 0),
    }));
  home.perCompany = input.companies
    .filter((c) => inFilter(c.id))
    .map((c) => ({ companyId: c.id, code: c.code, name: c.name, pendingKg: pendingByCompany.get(c.id) ?? 0 }))
    .sort((x, y) => x.code.localeCompare(y.code));
  home.unitCount = home.perCompany.length;
  home.sentThisWeek.changePct =
    lastWeekKg > 0 ? Math.round(((home.sentThisWeek.kg - lastWeekKg) / lastWeekKg) * 100) : null;
  return home;
}
