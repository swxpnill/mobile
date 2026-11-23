import { meSchema, updatePreferencesBodySchema } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { users } from '../db/schema/index.ts';
import { defineRoute } from '../http/route.ts';
import { toMe } from '../views/users.ts';

/** `GET /v1/me`, `PATCH /v1/me/preferences`. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/me', {
    action: 'self.view',
    response: { 200: meSchema },
    handler: async ({ user }) => ({ body: toMe(user) }),
  });

  defineRoute(app, 'PATCH', '/me/preferences', {
    action: 'self.view',
    body: updatePreferencesBodySchema,
    response: { 200: meSchema },
    handler: async ({ tx, user, body, now }) => {
      const preferences = { ...user.preferences, unitBasis: body.unitBasis };
      await tx.update(users).set({ preferences, updatedAt: new Date(now) }).where(eq(users.id, user.id));
      return { body: toMe({ ...user, preferences }) };
    },
  });
};
