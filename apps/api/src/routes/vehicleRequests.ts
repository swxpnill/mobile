import { vehicleRequestBodySchema, vehicleRequestSchema } from '@tonnage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defineRoute } from '../http/route.ts';
import { createVehicleRequest } from '../services/vehicleRequests.ts';

/** Request vehicle (B3 Task 8): staff asked the order's customer or broker to send a truck. */
export async function vehicleRequestRoutes(app: FastifyInstance): Promise<void> {
  defineRoute(app, 'POST', '/orders/:id/vehicle-requests', {
    action: 'truck.assign',
    idempotent: true,
    body: vehicleRequestBodySchema,
    response: { 201: z.object({ request: vehicleRequestSchema }) },
    async handler({ tx, user, scope, now, params, body }) {
      return { status: 201, body: await createVehicleRequest(tx, { user, scope, now }, params.id, body) };
    },
  });
}
