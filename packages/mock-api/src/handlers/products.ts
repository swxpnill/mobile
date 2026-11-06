import {
  type Product,
  type ProductBody,
  categoryTag,
  productBodySchema,
  productDisplayName,
  productListQuerySchema,
  updateProductBodySchema,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, notFound, stale, validationError } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, ProductRec } from '../store.ts';
import { type Authed, authed, logActivity, newId } from '../views.ts';

export function toProduct(p: ProductRec): Product {
  return {
    id: p.id,
    category: p.category,
    grade: p.grade,
    sizeLabel: p.sizeLabel,
    displayName: productDisplayName(p),
    tag: categoryTag(p.category),
    conversionPerMt: p.conversionPerMt,
    standardLengths: p.standardLengths.map((l) => ({ ...l })),
    companyIds: [...p.companyIds],
    active: p.active,
    version: p.version,
  };
}

export function findProduct(state: MockState, a: Authed, id: string | undefined): ProductRec {
  const p = state.products.find((x) => x.id === id && x.tenantId === a.user.tenantId);
  if (!p) throw notFound();
  return p;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const sortKey = (p: ProductRec) => `${p.category}\u0000${p.grade}\u0000${p.sizeLabel}`;

/** Companies must be this tenant's; the same category + grade + size may exist only once. */
function assertValid(state: MockState, tenantId: string, body: ProductBody, exceptId?: string): void {
  const own = new Set(state.companies.filter((c) => c.tenantId === tenantId).map((c) => c.id));
  if (body.companyIds.some((id) => !own.has(id))) {
    throw validationError([{ path: ['companyIds'], message: 'Unknown company' }]);
  }
  const name = productDisplayName(body).toLowerCase();
  const dup = state.products.some(
    (p) => p.tenantId === tenantId && p.id !== exceptId && productDisplayName(p).toLowerCase() === name,
  );
  if (dup) throw validationError([{ path: ['sizeLabel'], message: 'This product already exists' }]);
}

const fields = (body: ProductBody) => ({
  category: body.category,
  grade: body.grade,
  sizeLabel: body.sizeLabel,
  conversionPerMt: body.conversionPerMt,
  standardLengths: body.standardLengths.map((l) => ({ ...l })),
  companyIds: [...new Set(body.companyIds)],
});

export const productRoutes: RouteDef[] = [
  route('GET', '/v1/products', {
    action: 'masters.manage',
    query: productListQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { category, q, companyId, active } = ctx.query;
      const needle = q?.trim().toLowerCase() ?? '';
      const list = ctx.state.products.filter(
        (p) =>
          p.tenantId === a.user.tenantId &&
          (category === undefined || p.category.toLowerCase() === category.toLowerCase()) &&
          (companyId === undefined || p.companyIds.includes(companyId)) &&
          (active === undefined || p.active === active) &&
          (needle === '' || productDisplayName(p).toLowerCase().includes(needle)),
      );
      list.sort((x, y) => collator.compare(sortKey(x), sortKey(y)));
      return { body: list.map(toProduct) };
    },
  }),

  route('GET', '/v1/products/:id', {
    action: 'masters.manage',
    async handler(ctx) {
      return { body: toProduct(findProduct(ctx.state, authed(ctx), ctx.params.id)) };
    },
  }),

  route('POST', '/v1/products', {
    action: 'masters.manage',
    idempotent: true,
    body: productBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      assertValid(state, a.user.tenantId, body);
      const at = toIso(now);
      const rec: ProductRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        ...fields(body),
        active: true,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.products.push(rec);
      logActivity(state, a, now, { entityType: 'product', entityId: rec.id, action: 'product.created' });
      return { status: 201, body: toProduct(rec) };
    },
  }),

  route('PATCH', '/v1/products/:id', {
    action: 'masters.manage',
    body: updateProductBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const p = findProduct(state, a, ctx.params.id);
      if (body.version !== p.version) throw stale();
      assertValid(state, a.user.tenantId, body, p.id);
      Object.assign(p, { ...fields(body), active: body.active, version: p.version + 1, updatedAt: toIso(now) });
      logActivity(state, a, now, { entityType: 'product', entityId: p.id, action: 'product.updated' });
      return { body: toProduct(p) };
    },
  }),

  route('DELETE', '/v1/products/:id', {
    action: 'masters.manage',
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now } = ctx;
      const p = findProduct(state, a, ctx.params.id);
      if (state.orderLines.some((l) => l.productId === p.id)) throw new ApiError(409, 'PRODUCT_IN_USE');
      state.products.splice(state.products.indexOf(p), 1);
      logActivity(state, a, now, { entityType: 'product', entityId: p.id, action: 'product.deleted' });
      return { status: 204 };
    },
  }),
];
