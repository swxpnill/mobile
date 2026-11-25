import type { productListQuerySchema } from '@tonnage/shared';
import { and, asc, eq, exists, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Tx } from '../db/client.ts';
import { pgError } from '../db/pg-error.ts';
import { companies, productCompanies, products } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import type { ProductGraph, ProductRow } from '../views/products.ts';
import { isId } from './org.ts';

/** The name uniqueness the table enforces (see the schema), so a race ends the same way as the pre-check. */
const NAME_KEY = 'products_tenant_display_name_key';

/** Products with their companies in two sequential queries; ids that are not the caller's tenant's (or not uuids) are absent. */
export async function loadProducts(tx: Tx, ids: readonly string[]): Promise<Map<string, ProductGraph>> {
  const wanted = [...new Set(ids.filter(isId))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.select().from(products).where(inArray(products.id, wanted));
  return withCompanies(tx, rows);
}

async function withCompanies(tx: Tx, rows: ProductRow[]): Promise<Map<string, ProductGraph>> {
  const out = new Map<string, ProductGraph>(rows.map((r) => [r.id, { ...r, companyIds: [] }]));
  if (rows.length === 0) return out;
  // Row-level security keeps both queries to the caller's tenant; the links are read in `position` order.
  const links = await tx
    .select({ productId: productCompanies.productId, companyId: productCompanies.companyId })
    .from(productCompanies)
    .where(
      inArray(
        productCompanies.productId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(productCompanies.productId), asc(productCompanies.position));
  for (const l of links) out.get(l.productId)?.companyIds.push(l.companyId);
  return out;
}

/** The product with its companies, or 404 (the same for another tenant's, a random or a malformed id). */
export async function findProduct(tx: Tx, id: string | undefined): Promise<ProductGraph> {
  const found = isId(id) ? (await loadProducts(tx, [id])).get(id) : undefined;
  if (!found) throw new AppError(404, 'NOT_FOUND');
  return found;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const sortKey = (p: ProductRow) => `${p.category}\u0000${p.grade}\u0000${p.sizeLabel}`;

/** The list as the mock returns it: filtered here, sorted by category, grade, size with numbers read as numbers. */
export async function listProducts(
  tx: Tx,
  query: z.infer<typeof productListQuerySchema>,
): Promise<ProductGraph[]> {
  const { category, q, companyId, active } = query;
  const needle = q?.trim().toLowerCase() ?? '';
  const rows = await tx
    .select()
    .from(products)
    .where(
      and(
        category === undefined ? undefined : sql`lower(${products.category}) = ${category.toLowerCase()}`,
        companyId === undefined
          ? undefined
          : exists(
              tx
                .select({ one: sql`1` })
                .from(productCompanies)
                .where(
                  and(
                    eq(productCompanies.tenantId, products.tenantId),
                    eq(productCompanies.productId, products.id),
                    eq(productCompanies.companyId, companyId),
                  ),
                ),
            ),
        active === undefined ? undefined : eq(products.active, active),
        needle === ''
          ? undefined
          : sql`position(${needle} in lower(btrim(${products.category} || ' ' || ${products.grade}) || ' · ' || ${products.sizeLabel})) > 0`,
      ),
    );
  rows.sort((x, y) => collator.compare(sortKey(x), sortKey(y)));
  const graphs = await withCompanies(tx, rows);
  return rows.flatMap((r) => graphs.get(r.id) ?? []);
}

/** Every company must be the caller's tenant's (row-level security hides the others): else 422 at `companyIds`. */
export async function assertCompanies(tx: Tx, companyIds: readonly string[]): Promise<void> {
  const wanted = [...new Set(companyIds)];
  const known = wanted.length === 0 || !wanted.every(isId)
    ? []
    : await tx.select({ id: companies.id }).from(companies).where(inArray(companies.id, wanted));
  if (known.length !== wanted.length) {
    throw new AppError(422, 'VALIDATION', [{ path: ['companyIds'], message: 'Unknown company' }]);
  }
}

/** Replaces a product's company links with the given ids, once each, in the order given. */
export async function saveCompanies(
  tx: Tx,
  product: Pick<ProductRow, 'id' | 'tenantId'>,
  companyIds: readonly string[],
  at: Date,
): Promise<void> {
  await tx.delete(productCompanies).where(eq(productCompanies.productId, product.id));
  const unique = [...new Set(companyIds)];
  if (unique.length === 0) return;
  await tx.insert(productCompanies).values(
    unique.map((companyId, position) => ({
      tenantId: product.tenantId,
      productId: product.id,
      companyId,
      position,
      createdAt: at,
      updatedAt: at,
    })),
  );
}

/**
 * Runs a write inside a savepoint and turns a clash on the display name into the mock's 422 at
 * `sizeLabel`. The unique index is the guard, so two racing writes cannot both succeed.
 */
export async function withProductUniqueness<T>(tx: Tx, write: (sp: Tx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction(write);
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === NAME_KEY) {
      throw new AppError(422, 'VALIDATION', [{ path: ['sizeLabel'], message: 'This product already exists' }]);
    }
    throw e;
  }
}

/**
 * Whether an order line uses the product (the mock's `PRODUCT_IN_USE`). There are no order lines yet:
 * B2 Task 4 adds them and replaces this with a query on `order_lines.product_id`. Until then no
 * product is in use.
 */
export async function productInUse(tx: Tx, productId: string): Promise<boolean> {
  void tx;
  void productId;
  return false;
}
