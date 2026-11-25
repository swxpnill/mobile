import {
  productBodySchema,
  productListQuerySchema,
  productSchema,
  updateProductBodySchema,
} from '@tonnage/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { pgError } from '../db/pg-error.ts';
import { products } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import {
  assertCompanies,
  findProduct,
  listProducts,
  PRODUCT_LINE_FK,
  productInUse,
  saveCompanies,
  withProductUniqueness,
} from '../services/products.ts';
import { toProduct } from '../views/products.ts';

/** `GET|POST /v1/products`, `GET|PATCH|DELETE /v1/products/:id`: every one `masters.manage`, as in the mock. */
export const productRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/products', {
    action: 'masters.manage',
    query: productListQuerySchema,
    response: { 200: z.array(productSchema) },
    handler: async ({ tx, query }) => ({ body: (await listProducts(tx, query)).map(toProduct) }),
  });

  defineRoute(app, 'GET', '/products/:id', {
    action: 'masters.manage',
    response: { 200: productSchema },
    handler: async ({ tx, params }) => ({ body: toProduct(await findProduct(tx, params.id)) }),
  });

  defineRoute(app, 'POST', '/products', {
    action: 'masters.manage',
    idempotent: true,
    body: productBodySchema,
    response: { 201: productSchema },
    handler: async ({ tx, user, body, now }) => {
      await assertCompanies(tx, body.companyIds);
      const at = new Date(now);
      const id = uuidv7();
      await withProductUniqueness(tx, async (sp) => {
        const [row] = await sp
          .insert(products)
          .values({
            id,
            tenantId: user.tenantId,
            category: body.category,
            grade: body.grade,
            sizeLabel: body.sizeLabel,
            conversionPerMt: body.conversionPerMt,
            standardLengths: body.standardLengths,
            createdBy: user.id,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row) throw new Error('product insert returned no row');
        await saveCompanies(sp, row, body.companyIds, at);
      });
      await logActivity(tx, user, now, { entityType: 'product', entityId: id, action: 'product.created' });
      return { status: 201, body: toProduct(await findProduct(tx, id)) };
    },
  });

  defineRoute(app, 'PATCH', '/products/:id', {
    action: 'masters.manage',
    body: updateProductBodySchema,
    response: { 200: productSchema },
    handler: async ({ tx, user, params, body, now }) => {
      const p = await findProduct(tx, params.id);
      if (body.version !== p.version) throw new AppError(409, 'STALE');
      await assertCompanies(tx, body.companyIds);
      const at = new Date(now);
      await withProductUniqueness(tx, async (sp) => {
        const [row] = await sp
          .update(products)
          .set({
            category: body.category,
            grade: body.grade,
            sizeLabel: body.sizeLabel,
            conversionPerMt: body.conversionPerMt,
            standardLengths: body.standardLengths,
            active: body.active,
            version: p.version + 1,
            updatedAt: at,
          })
          .where(and(eq(products.id, p.id), eq(products.version, body.version)))
          .returning();
        // Zero rows: a concurrent write bumped the version after the read above.
        if (!row) throw new AppError(409, 'STALE');
        await saveCompanies(sp, row, body.companyIds, at);
      });
      await logActivity(tx, user, now, { entityType: 'product', entityId: p.id, action: 'product.updated' });
      return { body: toProduct(await findProduct(tx, p.id)) };
    },
  });

  defineRoute(app, 'DELETE', '/products/:id', {
    action: 'masters.manage',
    response: { 204: z.null() },
    handler: async ({ tx, user, params, now }) => {
      const p = await findProduct(tx, params.id);
      if (await productInUse(tx, p.id)) throw new AppError(409, 'PRODUCT_IN_USE');
      try {
        // A savepoint, so a refused delete leaves the request's transaction usable for the error.
        await tx.transaction((sp) => sp.delete(products).where(eq(products.id, p.id)));
      } catch (e) {
        // A line committed after the check above: its foreign key refuses the delete.
        const pg = pgError(e);
        if (pg?.code === '23503' && pg.constraint === PRODUCT_LINE_FK) throw new AppError(409, 'PRODUCT_IN_USE');
        throw e;
      }
      await logActivity(tx, user, now, { entityType: 'product', entityId: p.id, action: 'product.deleted' });
      return { status: 204 };
    },
  });
};
