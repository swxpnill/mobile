import {
  type DispatchBoard,
  type RecentVehicle,
  type Truck,
  assignTruckBodySchema,
  cancelTruckBodySchema,
  dispatchBoardSchema,
  dispatchQuerySchema,
  editTruckBodySchema,
  isOpenTruckState,
  istDayStart,
  recentVehicleSchema,
  subOrderNumber,
  truckSchema,
} from '@tonnage/shared';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { trucks } from '../db/schema/index.ts';
import { defineRoute } from '../http/route.ts';
import { anyId } from '../services/orderGraph.ts';
import { assignTruck, cancelTruck, editTruck } from '../services/dispatch/assign.ts';
import { assertVisible, findTruckRow, inPlantScope, truckViewCtx } from '../services/dispatch/truckViews.ts';
import { type TruckRow } from '../views/orderGraph.ts';
import { boardOrder, newestFirst, sameIstDay, toTruck, vehicleKey } from '../views/trucks.ts';

/** How many of the newest trucks recent vehicles looks through for its 8 distinct vehicles. */
const RECENT_SCAN = 500;

export async function truckRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, 'POST', '/sub-orders/:id/trucks', {
    action: 'truck.assign',
    idempotent: true,
    body: assignTruckBodySchema,
    response: { 201: truckSchema },
    async handler({ tx, user, scope, now, params, body }) {
      return { status: 201, body: await assignTruck(tx, { user, scope, now }, params.id, body) };
    },
  });

  defineRoute(app, 'PATCH', '/trucks/:id', {
    action: 'truck.edit',
    idempotent: true,
    body: editTruckBodySchema,
    response: { 200: truckSchema },
    async handler({ tx, user, scope, now, params, body }) {
      return { body: await editTruck(tx, { user, scope, now }, params.id, body) };
    },
  });

  defineRoute(app, 'POST', '/trucks/:id/cancel', {
    action: 'truck.cancel',
    idempotent: true,
    body: cancelTruckBodySchema,
    response: { 200: truckSchema },
    async handler({ tx, user, scope, now, params, body }) {
      return { body: await cancelTruck(tx, { user, scope, now }, params.id, body) };
    },
  });

  // Before /trucks/:id, or "recent-vehicles" is read as a truck id.
  defineRoute(app, 'GET', '/trucks/recent-vehicles', {
    action: 'truck.assign',
    response: { 200: z.array(recentVehicleSchema) },
    async handler({ tx }) {
      const rows = await tx.select().from(trucks).orderBy(desc(trucks.assignedAt), desc(trucks.id)).limit(RECENT_SCAN);
      const seen = new Set<string>();
      const out: RecentVehicle[] = [];
      for (const t of rows.sort(newestFirst)) {
        const key = vehicleKey(t.vehicleNo);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ vehicleNo: t.vehicleNo, transporterId: t.transporterId, driverName: t.driverName, driverPhone: t.driverPhone });
        if (out.length === 8) break;
      }
      return { body: out };
    },
  });

  defineRoute(app, 'GET', '/trucks/:id', {
    action: 'dispatch.view',
    response: { 200: truckSchema },
    async handler({ tx, user, scope, now, params }) {
      const row = await findTruckRow(tx, scope, params.id);
      const c = await truckViewCtx(tx, user, scope, now, [row.id], { supervisors: true, weighments: true });
      assertVisible(c, row.id);
      return { body: toTruck(c, row.id, { withWeighments: true }) };
    },
  });

  defineRoute(app, 'GET', '/dispatch', {
    action: 'dispatch.view',
    query: dispatchQuerySchema,
    response: { 200: dispatchBoardSchema },
    async handler({ tx, user, scope, now, query }) {
      const counts = { assigned: 0, at_gate: 0, loading: 0, weighed: 0, dispatched_today: 0 };
      if (scope.kind === 'plants' && scope.plantIds.length === 0) return { body: { counts, items: [] } satisfies DispatchBoard };
      // Candidates: what the counts and any filter can show, open trucks and today's dispatches.
      const startOfDay = new Date(istDayStart(now));
      const rows = await tx
        .select({ id: trucks.id })
        .from(trucks)
        .where(
          and(
            scope.kind === 'all' ? undefined : anyId(trucks.plantId, scope.plantIds),
            or(
              sql`${trucks.state} in ('assigned', 'at_gate', 'loading', 'weighed')`,
              and(eq(trucks.state, 'dispatched'), gte(trucks.dispatchedAt, startOfDay)),
            ),
          ),
        );
      const c = await truckViewCtx(
        tx,
        user,
        scope,
        now,
        rows.map((r) => r.id),
      );
      if (query.companyId !== undefined && !c.visibleCompanyIds.has(query.companyId)) {
        return { body: { counts, items: [] } satisfies DispatchBoard };
      }
      const inScope = [...c.places.values()].filter(
        (p) =>
          inPlantScope(scope, p.truck.truck.plantId) &&
          c.visibleCompanyIds.has(p.sub.sub.companyId) &&
          (query.companyId === undefined || p.sub.sub.companyId === query.companyId),
      );
      const isToday = (t: TruckRow) =>
        t.state === 'dispatched' && t.dispatchedAt !== null && sameIstDay(t.dispatchedAt.getTime(), now);
      for (const p of inScope) {
        const t = p.truck.truck;
        if (isToday(t)) counts.dispatched_today += 1;
        else if (t.state === 'assigned' || t.state === 'at_gate' || t.state === 'loading' || t.state === 'weighed') counts[t.state] += 1;
      }
      const needle = query.q === undefined ? '' : query.q.trim().toLowerCase();
      const items = inScope
        .filter((p) => {
          const t = p.truck.truck;
          const wanted =
            query.state === 'dispatched_today' ? isToday(t) : query.state === 'open' ? isOpenTruckState(t.state) : t.state === query.state;
          if (!wanted) return false;
          if (needle === '') return true;
          const number = p.graph.order.number ?? '';
          const customer = p.graph.order.customerId ? (c.partyById.get(p.graph.order.customerId)?.name ?? '') : '';
          const hay = [
            t.vehicleNo.toLowerCase(),
            vehicleKey(t.vehicleNo),
            number.toLowerCase(),
            subOrderNumber(number, p.sub.sub.suffix).toLowerCase(),
            customer.toLowerCase(),
          ];
          return hay.some((h) => h.includes(needle) || h.includes(vehicleKey(needle)));
        })
        .map((p) => p.truck.truck)
        .sort(boardOrder)
        .map((t) => {
          const full = toTruck(c, t.id, { withWeighments: false }) as Partial<Truck>;
          delete full.weighments;
          delete full.supervisors;
          return full as Omit<Truck, 'weighments' | 'supervisors'>;
        });
      return { body: { counts, items } satisfies DispatchBoard };
    },
  });
}
