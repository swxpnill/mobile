import { idSchema, type PlantScope } from '@tonnage/shared';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { companies, plants } from '../db/schema/index.ts';
import { pgError } from '../db/pg-error.ts';
import { AppError } from '../http/errors.ts';

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
  const found = (await visibleCompanies(tx, scope)).find((c) => c.id === id);
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
 * Ruling 8: a company with open or partly dispatched sub-orders cannot be deactivated. There are no
 * sub-orders in B1, so this always resolves; B2 adds the `409 COMPANY_HAS_OPEN_ORDERS` check.
 */
export async function assertCompanyDeactivatable(tx: Tx, companyId: string): Promise<void> {
  void tx;
  void companyId;
  // Intentionally empty until B2.
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
