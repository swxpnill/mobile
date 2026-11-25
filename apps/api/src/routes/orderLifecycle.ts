import {
  activityEntrySchema,
  deleteOrderBodySchema,
  deletePreviewSchema,
  moveQuantityBodySchema,
  orderSchema,
  reopenBodySchema,
  shortCloseBodySchema,
  updateOrderBodySchema,
  type PlantScope,
} from '@tonnage/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../db/client.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { defineRoute } from '../http/route.ts';
import { editOrder } from '../services/orderEdit.ts';
import { findOrder } from '../services/orderGraph.ts';
import {
  deletePreview,
  hardDeleteOrder,
  moveQuantity,
  orderActivity,
  reopenSubOrder,
  shortCloseSubOrder,
} from '../services/orderLifecycle.ts';
import { toOrder } from '../views/orders.ts';

/** The order as it stands after the write, as the caller sees it. */
async function orderBody(tx: Tx, c: { user: AuthedUser; scope: PlantScope; now: number }, orderId: string) {
  const { graph, ctx } = await findOrder(tx, c.user, c.scope, c.now, orderId);
  return toOrder(graph, ctx);
}

/**
 * The order lifecycle (Ruling 1), as the mock: `PATCH /v1/orders/:id`, short close and reopen of a
 * sub-order, move quantity, delete preview, hard delete, activity. Every write is idempotent (the
 * pipeline refuses one without a key) and versioned (409 STALE).
 */
export const orderLifecycleRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'PATCH', '/orders/:id', {
    action: 'order.edit',
    idempotent: true,
    body: updateOrderBodySchema,
    response: { 200: orderSchema },
    handler: async ({ tx, user, scope, params, body, now }) => {
      const c = { user, scope, now };
      const { orderId, warnings } = await editOrder(tx, c, params.id, body);
      const order = await orderBody(tx, c, orderId);
      return { body: warnings.length > 0 ? { ...order, warnings } : order };
    },
  });

  defineRoute(app, 'POST', '/sub-orders/:id/short-close', {
    action: 'order.shortClose',
    idempotent: true,
    body: shortCloseBodySchema,
    response: { 200: orderSchema },
    handler: async ({ tx, user, scope, params, body, now }) => {
      const c = { user, scope, now };
      return { body: await orderBody(tx, c, await shortCloseSubOrder(tx, c, params.id, body)) };
    },
  });

  defineRoute(app, 'POST', '/sub-orders/:id/reopen', {
    action: 'order.reopen',
    idempotent: true,
    body: reopenBodySchema,
    response: { 200: orderSchema },
    handler: async ({ tx, user, scope, params, body, now }) => {
      const c = { user, scope, now };
      return { body: await orderBody(tx, c, await reopenSubOrder(tx, c, params.id, body.version)) };
    },
  });

  defineRoute(app, 'POST', '/orders/:id/move-quantity', {
    action: 'order.edit',
    idempotent: true,
    body: moveQuantityBodySchema,
    response: { 200: orderSchema },
    handler: async ({ tx, user, scope, params, body, now }) => {
      const c = { user, scope, now };
      return { body: await orderBody(tx, c, await moveQuantity(tx, c, params.id, body)) };
    },
  });

  defineRoute(app, 'GET', '/orders/:id/delete-preview', {
    action: 'order.hardDelete',
    response: { 200: deletePreviewSchema },
    handler: async ({ tx, user, scope, params, now }) => {
      const { graph } = await findOrder(tx, user, scope, now, params.id);
      return { body: deletePreview(graph) };
    },
  });

  defineRoute(app, 'DELETE', '/orders/:id', {
    action: 'order.hardDelete',
    idempotent: true,
    body: deleteOrderBodySchema,
    handler: async ({ tx, user, scope, params, body, now }) => {
      await hardDeleteOrder(tx, { user, scope, now }, params.id, body);
      return { status: 204 };
    },
  });

  defineRoute(app, 'GET', '/orders/:id/activity', {
    action: 'order.view',
    response: { 200: z.array(activityEntrySchema) },
    handler: async ({ tx, user, scope, params, now }) => ({ body: await orderActivity(tx, { user, scope, now }, params.id) }),
  });
};
