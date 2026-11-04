import { tenantSettingsSchema } from '@tonnage/shared';
import { z } from 'zod';
import { issueDetails, validationError } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import { authed, logActivity } from '../views.ts';

/** Any JSON object; it is merged over the current settings and the result validated. */
const settingsPatchSchema = z.record(z.string(), z.unknown());

export const settingsRoutes: RouteDef[] = [
  route('GET', '/v1/settings', {
    action: 'self.view',
    async handler(ctx) {
      return { body: { ...authed(ctx).tenant.settings } };
    },
  }),

  route('PATCH', '/v1/settings', {
    action: 'settings.manage',
    body: settingsPatchSchema,
    async handler(ctx) {
      const a = authed(ctx);
      const parsed = tenantSettingsSchema.safeParse({ ...a.tenant.settings, ...ctx.body });
      if (!parsed.success) throw validationError(issueDetails(parsed.error.issues));
      a.tenant.settings = parsed.data;
      logActivity(ctx.state, a, ctx.now, {
        entityType: 'tenant',
        entityId: a.tenant.id,
        action: 'settings.updated',
        meta: { keys: Object.keys(ctx.body) },
      });
      return { body: { ...parsed.data } };
    },
  }),
];
