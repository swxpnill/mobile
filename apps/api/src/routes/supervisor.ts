import { doneTodaySchema, syncBodySchema, syncResponseSchema, tasksPageSchema } from '@tonnage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute } from '../http/route.ts';
import { syncWeighments } from '../services/dispatch/sync.ts';
import { doneToday, pullTasks } from '../services/dispatch/tasks.ts';

const tasksQuerySchema = z.object({ cursor: z.iso.datetime({ offset: true }).optional() });

/** The supervisor's phone: weighment sync, the tasks pull and done today (B3 Tasks 5 and 7). */
export async function supervisorRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, 'GET', '/supervisor/tasks', {
    action: 'tasks.view',
    query: tasksQuerySchema,
    response: { 200: tasksPageSchema },
    async handler({ tx, user, scope, now, query }) {
      return { body: await pullTasks(tx, { user, scope, now }, query.cursor) };
    },
  });

  defineRoute(app, 'GET', '/supervisor/done-today', {
    action: 'tasks.view',
    response: { 200: doneTodaySchema },
    async handler({ tx, user, scope, now }) {
      return { body: await doneToday(tx, { user, scope, now }) };
    },
  });

  // Each event commits or rolls back on its own (§6.4); the request transaction keeps the key.
  defineRoute(app, 'POST', '/weighments/sync', {
    action: 'weighment.capture',
    idempotent: true,
    eventTransactions: true,
    body: syncBodySchema,
    response: { 200: syncResponseSchema },
    async handler(ctx) {
      return { body: await syncWeighments(ctx) };
    },
  });
}
