import {
  createOrderBodySchema,
  draftSchema,
  orderListQuerySchema,
  orderListSchema,
  orderSchema,
} from '@tonnage/shared';
import type { FastifyPluginAsync } from 'fastify';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import { createDraft } from '../services/drafts.ts';
import { findOrder, loadOrderGraph, orderViewCtx } from '../services/orderGraph.ts';
import { listOrders } from '../services/orderList.ts';
import { createOrder, duplicatePayload } from '../services/orders.ts';
import { toDraft } from '../views/drafts.ts';
import { toOrder } from '../views/orders.ts';

/**
 * `POST|GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/duplicate`, as in the mock.
 * Drafts (`/v1/orders/drafts…`) are static paths, so Fastify never reads "drafts" as an order id.
 */
export const orderRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'POST', '/orders', {
    action: 'order.create',
    idempotent: true,
    body: createOrderBodySchema,
    response: { 201: orderSchema },
    handler: async ({ tx, user, scope, body, now }) => {
      const id = await createOrder(tx, { user, now }, body);
      const graph = (await loadOrderGraph(tx, [id])).get(id);
      if (!graph) throw new Error('order vanished after insert');
      return { status: 201, body: toOrder(graph, await orderViewCtx(tx, user, scope, now, [graph])) };
    },
  });

  defineRoute(app, 'GET', '/orders', {
    action: 'order.view',
    query: orderListQuerySchema,
    response: { 200: orderListSchema },
    handler: async ({ tx, user, scope, query, now }) => ({ body: await listOrders(tx, { user, scope, now }, query) }),
  });

  defineRoute(app, 'GET', '/orders/:id', {
    action: 'order.view',
    response: { 200: orderSchema },
    handler: async ({ tx, user, scope, params, now }) => {
      const { graph, ctx } = await findOrder(tx, user, scope, now, params.id);
      return { body: toOrder(graph, ctx) };
    },
  });

  defineRoute(app, 'POST', '/orders/:id/duplicate', {
    action: 'order.duplicate',
    idempotent: true,
    response: { 201: draftSchema },
    handler: async ({ tx, user, scope, params, now }) => {
      const { graph } = await findOrder(tx, user, scope, now, params.id);
      const draft = await createDraft(tx, user, duplicatePayload(graph), now);
      await logActivity(tx, user, now, {
        entityType: 'order',
        entityId: graph.order.id,
        action: 'order.duplicated',
        meta: { draftId: draft.id },
        orderId: graph.order.id,
      });
      return { status: 201, body: toDraft(draft, user.name) };
    },
  });
};
