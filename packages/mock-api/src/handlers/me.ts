import { updatePreferencesBodySchema } from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { route, type RouteDef } from '../router.ts';
import { authed, toMe } from '../views.ts';

export const meRoutes: RouteDef[] = [
  route('GET', '/v1/me', {
    action: 'self.view',
    async handler(ctx) {
      const a = authed(ctx);
      return { body: toMe(a.user, a.tenant) };
    },
  }),

  route('PATCH', '/v1/me/preferences', {
    action: 'self.view',
    body: updatePreferencesBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      a.user.preferences = { ...a.user.preferences, unitBasis: ctx.body.unitBasis };
      a.user.updatedAt = toIso(ctx.now);
      return { body: toMe(a.user, a.tenant) };
    },
  }),
];
