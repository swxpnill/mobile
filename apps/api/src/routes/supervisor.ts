import { syncBodySchema, syncResponseSchema } from '@tonnage/shared';
import type { FastifyInstance } from 'fastify';
import { defineRoute } from '../http/route.ts';
import { syncWeighments } from '../services/dispatch/sync.ts';

/** The supervisor's phone: weighment sync (B3 Task 5); the tasks pull and done today follow (Task 7). */
export async function supervisorRoutes(app: FastifyInstance): Promise<void> {
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
