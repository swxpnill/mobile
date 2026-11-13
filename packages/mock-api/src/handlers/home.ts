import { type Home, billedRate, homeQuerySchema, isTerminal, istDateParts, lineValue } from '@tonnage/shared';
import { DAY } from '../clock.ts';
import { notFound } from '../errors.ts';
import { ageDays, orderCtx, visibleSubOrders } from '../order-views.ts';
import { isOpenTruck, orderMath } from '../orders-math.ts';
import { route, type RouteDef } from '../router.ts';
import { authed } from '../views.ts';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** Start of the IST calendar day containing `ms`, as epoch ms. */
function istDayStart(ms: number): number {
  const { year, month, day } = istDateParts(ms);
  return Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
}

/** Monday 00:00 IST of the week containing `ms`. */
function istWeekStart(ms: number): number {
  const dayStart = istDayStart(ms);
  const weekday = new Date(dayStart + IST_OFFSET_MS).getUTCDay(); // 0 = Sunday
  return dayStart - ((weekday + 6) % 7) * DAY;
}

export const homeRoutes: RouteDef[] = [
  route('GET', '/v1/home', {
    action: 'order.view',
    query: homeQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      const math = orderMath(state);
      const c = orderCtx(state, math, a, now);
      const companyId = ctx.query.companyId;
      if (companyId !== undefined && !c.visibleCompanyIds.has(companyId)) throw notFound();
      const inFilter = (id: string) => companyId === undefined || id === companyId;

      const today = istDayStart(now);
      const week = istWeekStart(now);
      const lastWeek = week - 7 * DAY;
      const pendingByCompany = new Map<string, number>();
      const home: Home = {
        pendingKg: 0,
        openOrders: 0,
        unitCount: 0,
        perCompany: [],
        agedOrders: 0,
        agedOrderDays: a.tenant.settings.agedOrderDays,
        bookedToday: { kg: 0, orders: 0, valueRupees: 0 },
        dispatchedToday: { kg: 0, trucks: 0 },
        sentThisWeek: { kg: 0, changePct: null },
        inPlant: [],
      };
      let lastWeekKg = 0;

      for (const o of state.orders) {
        if (o.tenantId !== a.user.tenantId) continue;
        const subs = visibleSubOrders(c, o).filter((s) => inFilter(s.companyId));
        if (subs.length === 0) continue;
        let orderPending = 0;
        let open = false;
        for (const s of subs) {
          if (!isTerminal(math.subOrderStatus(s))) {
            open = true;
            const p = math.subOrderTotals(s).pendingKg;
            orderPending += p;
            pendingByCompany.set(s.companyId, (pendingByCompany.get(s.companyId) ?? 0) + p);
          }
          for (const t of math.trucksOf(s.id)) {
            if (t.state !== 'dispatched' || !t.dispatchedAt) continue;
            const at = Date.parse(t.dispatchedAt);
            const net = t.allocations.reduce((sum, x) => sum + x.netKg, 0);
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
          if (orderPending > 0 && ageDays(o, now) > a.tenant.settings.agedOrderDays) home.agedOrders += 1;
        }
        if (Date.parse(o.createdAt) >= today) {
          const lines = subs.flatMap((s) => math.linesOf(s.id));
          home.bookedToday.orders += 1;
          home.bookedToday.kg += lines.reduce((sum, l) => sum + l.orderedKg, 0);
          home.bookedToday.valueRupees =
            (home.bookedToday.valueRupees ?? 0) +
            lines.reduce((sum, l) => sum + lineValue(l.orderedKg, billedRate(l.rate, l.overpricePerMt)), 0);
        }
      }

      const rank = { loading: 0, at_gate: 1, assigned: 2 } as const;
      home.inPlant = state.trucks
        .filter((t) => {
          if (t.tenantId !== a.user.tenantId || !isOpenTruck(t)) return false;
          if (a.scope.kind !== 'all' && !a.scope.plantIds.includes(t.plantId)) return false;
          const sub = state.subOrders.find((x) => x.id === t.subOrderId);
          return sub !== undefined && c.visibleCompanyIds.has(sub.companyId) && inFilter(sub.companyId);
        })
        .sort((x, y) => (rank[x.state as keyof typeof rank] ?? 9) - (rank[y.state as keyof typeof rank] ?? 9) || (x.assignedAt < y.assignedAt ? -1 : 1))
        .map((t) => {
          const sub = state.subOrders.find((x) => x.id === t.subOrderId);
          return {
            truckId: t.id,
            vehicleNo: t.vehicleNo,
            companyCode: (sub && c.companyById.get(sub.companyId)?.code) ?? '',
            state: t.state,
            plannedKg: t.plan.reduce((sum, p) => sum + p.plannedKg, 0),
          };
        });

      home.perCompany = [...c.visibleCompanyIds]
        .filter(inFilter)
        .map((id) => {
          const co = c.companyById.get(id);
          return { companyId: id, code: co?.code ?? '', name: co?.name ?? '', pendingKg: pendingByCompany.get(id) ?? 0 };
        })
        .sort((x, y) => x.code.localeCompare(y.code));
      home.unitCount = home.perCompany.length;
      home.sentThisWeek.changePct =
        lastWeekKg > 0 ? Math.round(((home.sentThisWeek.kg - lastWeekKg) / lastWeekKg) * 100) : null;
      return { body: home };
    },
  }),
];
