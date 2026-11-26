import { idSchema, isTerminal, type PlantScope } from '@tonnage/shared';
import { and, eq, exists, inArray, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { companies, plants, subOrders } from '../db/schema/index.ts';
import { pgError } from '../db/pg-error.ts';
import { AppError } from '../http/errors.ts';
import { graphMath } from '../views/orderGraph.ts';
import { loadOrderGraph } from './orderGraph.ts';

type CompanyRow = typeof companies.$inferSelect;
type PlantRow = typeof plants.$inferSelect;

/** Row-level security already limits every query here to the caller's tenant. */
function plantFilter(scope: PlantScope): SQL | undefined {
  return scope.kind === 'all' ? undefined : inArray(plants.id, scope.plantIds);
}

/** Ids that are not uuids can never match a row; asking Postgres would be an error, not a 404. */
export const isId = (id: string | undefined): id is string => idSchema.safeParse(id).success;

/** Plants visible to the caller, optionally of one company. */
export async function visiblePlants(tx: Tx, scope: PlantScope, companyId?: string): Promise<PlantRow[]> {
  if (scope.kind === 'plants' && scope.plantIds.length === 0) return [];
  return tx
    .select()
    .from(plants)
    .where(and(plantFilter(scope), companyId === undefined ? undefined : eq(plants.companyId, companyId)))
    .orderBy(plants.createdAt, plants.id);
}

/** Companies visible to the caller: plant roles only see companies owning one of their plants. */
export async function visibleCompanies(tx: Tx, scope: PlantScope): Promise<CompanyRow[]> {
  if (scope.kind === 'all') return tx.select().from(companies).orderBy(companies.createdAt, companies.id);
  const owning = await visiblePlants(tx, scope);
  const ids = [...new Set(owning.map((p) => p.companyId))];
  if (ids.length === 0) return [];
  return tx.select().from(companies).where(inArray(companies.id, ids)).orderBy(companies.createdAt, companies.id);
}

/** Company by id within tenant and scope; 404 otherwise (the same for missing and out of scope). */
export async function findCompany(tx: Tx, scope: PlantScope, id: string | undefined): Promise<CompanyRow> {
  if (!isId(id)) throw new AppError(404, 'NOT_FOUND');
  if (scope.kind === 'plants' && scope.plantIds.length === 0) throw new AppError(404, 'NOT_FOUND');
  // One row by primary key; a plant role also needs one of its plants to belong to the company.
  const owned =
    scope.kind === 'all'
      ? undefined
      : exists(
          tx
            .select({ one: sql`1` })
            .from(plants)
            .where(and(eq(plants.companyId, companies.id), inArray(plants.id, scope.plantIds))),
        );
  const [found] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, id), owned));
  if (!found) throw new AppError(404, 'NOT_FOUND');
  return found;
}

export async function findPlant(tx: Tx, scope: PlantScope, id: string | undefined): Promise<PlantRow> {
  if (!isId(id)) throw new AppError(404, 'NOT_FOUND');
  const [found] = await tx
    .select()
    .from(plants)
    .where(and(eq(plants.id, id), plantFilter(scope)));
  if (!found) throw new AppError(404, 'NOT_FOUND');
  return found;
}

/**
 * Ruling 8 (spec §5.3): a company with open or partly dispatched sub-orders cannot be deactivated
 * (409 COMPANY_HAS_OPEN_ORDERS with their count), as the mock's `assertCompanyDeactivatable`.
 * Statuses are derived, so the company's sub-orders are loaded with their orders' graphs.
 */
export async function assertCompanyDeactivatable(tx: Tx, companyId: string): Promise<void> {
  // The company row first (lock order across the API: company rows before order rows). An order
  // create holds it FOR SHARE from its company check to commit, so this waits for that order and
  // counts it; a create arriving after this lock waits and then sees the company inactive.
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for('update');
  const rows = await tx
    .select({ orderId: subOrders.orderId })
    .from(subOrders)
    .where(eq(subOrders.companyId, companyId));
  if (rows.length === 0) return;
  const graphs = await loadOrderGraph(
    tx,
    rows.map((r) => r.orderId),
  );
  let open = 0;
  for (const g of graphs.values()) {
    const m = graphMath(g);
    open += g.subOrders.filter((s) => s.sub.companyId === companyId && !isTerminal(m.subOrderStatus(s))).length;
  }
  if (open > 0) throw new AppError(409, 'COMPANY_HAS_OPEN_ORDERS', { openSubOrders: open });
}

/**
 * Runs a company write; a unique violation on (tenant_id, code) becomes 422 VALIDATION at `['code']`.
 * Detected by constraint name, not by message text. The handler throws, so the pipeline rolls back.
 */
export async function withCodeUniqueness<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === 'companies_tenant_id_code_key') {
      throw new AppError(422, 'VALIDATION', [
        { path: ['code'], message: 'This code is already used by another company' },
      ]);
    }
    throw e;
  }
}
