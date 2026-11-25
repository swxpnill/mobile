import { tenantSettingsSchema, type TenantSettings } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { tenants } from '../db/schema/index.ts';
import { AppError, issueDetails } from '../http/errors.ts';
import { defineRoute } from '../http/route.ts';
import { logActivity } from '../services/activity.ts';
import { loadSettings } from '../services/settings.ts';

/** Any JSON object; it is merged over the current settings and the result validated. */
const settingsPatchSchema = z.record(z.string(), z.unknown());

/** `GET|PATCH /v1/settings`. The tenants table has no RLS, so every query names the tenant explicitly. */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  defineRoute(app, 'GET', '/settings', {
    action: 'self.view',
    response: { 200: tenantSettingsSchema },
    handler: async ({ tx, user }) => ({ body: await loadSettings(tx, user.tenantId, false) }),
  });

  defineRoute(app, 'PATCH', '/settings', {
    action: 'settings.manage',
    body: settingsPatchSchema,
    response: { 200: tenantSettingsSchema },
    handler: async ({ tx, user, body, now }) => {
      const before = await loadSettings(tx, user.tenantId, true);
      const parsed = tenantSettingsSchema.safeParse({ ...before, ...body });
      if (!parsed.success) throw new AppError(422, 'VALIDATION', issueDetails(parsed.error.issues));
      // Unknown keys are stripped by the schema; re-sending a current value is not a change.
      const changed = (Object.keys(parsed.data) as (keyof TenantSettings)[]).filter(
        (k) => parsed.data[k] !== before[k],
      );
      if (changed.length > 0) {
        await tx
          .update(tenants)
          .set({ settings: parsed.data, updatedAt: new Date(now) })
          .where(eq(tenants.id, user.tenantId));
        await logActivity(tx, user, now, {
          entityType: 'tenant',
          entityId: user.tenantId,
          action: 'settings.updated',
          meta: { keys: changed },
        });
      }
      return { body: parsed.data };
    },
  });
};
