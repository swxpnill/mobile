import type { Home, PlantScope } from '@tonnage/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { homeQuerySchema } from '@tonnage/shared';
import type { Tx } from '../db/client.ts';
import { orders, subOrders } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { AppError } from '../http/errors.ts';
import { toHome } from '../views/home.ts';
import { anyId, loadOrderGraph } from './orderGraph.ts';
import { visibleCompanies } from './org.ts';
import { loadSettings } from './settings.ts';

/**
 * `GET /v1/home`: the graphs of every order with a sub-order of the caller's companies (or of the
 * chosen unit), loaded in at most six queries, summed in TypeScript (Ruling 4). A unit outside the
 * caller's scope is 404, as in the mock.
 */
export async function loadHome(
  tx: Tx,
  ctx: { user: AuthedUser; scope: PlantScope; now: number },
  query: z.infer<typeof homeQuerySchema>,
): Promise<Home> {
  const { user, scope, now } = ctx;
  const companies = await visibleCompanies(tx, scope);
  const visibleIds = companies.map((c) => c.id);
  if (query.companyId !== undefined && !visibleIds.includes(query.companyId)) throw new AppError(404, 'NOT_FOUND');
  const settings = await loadSettings(tx, user.tenantId);
  const wanted = query.companyId === undefined ? visibleIds : [query.companyId];
  const candidates =
    wanted.length === 0
      ? []
      : await tx
          .select({ id: orders.id })
          .from(orders)
          .where(
            sql`exists (select 1 from ${subOrders}
                         where ${subOrders.tenantId} = ${orders.tenantId}
                           and ${subOrders.orderId} = ${orders.id}
                           and ${anyId(subOrders.companyId, wanted)})`,
          );
  const graphs = await loadOrderGraph(
    tx,
    candidates.map((c) => c.id),
  );
  return toHome(graphs.values(), { now, settings, scope, companies, companyId: query.companyId });
}
