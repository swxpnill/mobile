import { notificationListQuerySchema, pushTokenBodySchema } from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { notFound, validationError } from '../errors.ts';
import { NOTIFICATION_PAGE, listFor, toNotification } from '../notifications.ts';
import { route, type RouteDef } from '../router.ts';
import { authed } from '../views.ts';

/**
 * Page cursor: the last row's `createdAt` and id (rows sort by both, newest first). Plain text,
 * no Buffer: the mock also runs inside the app.
 */
const encodeCursor = (createdAt: string, id: string) => `${createdAt}|${id}`;
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id, extra] = cursor.split('|');
  if (!createdAt || !id || extra !== undefined || Number.isNaN(Date.parse(createdAt))) {
    throw validationError([{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return { createdAt, id };
}
const before = (n: { createdAt: string; id: string }, c: { createdAt: string; id: string }) =>
  n.createdAt < c.createdAt || (n.createdAt === c.createdAt && n.id < c.id);

/** Every person sees and changes only their own notifications (`self.view`, F5 Ruling 5). */
export const notificationRoutes: RouteDef[] = [
  route('GET', '/v1/notifications', {
    action: 'self.view',
    query: notificationListQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const after = ctx.query.cursor ? decodeCursor(ctx.query.cursor) : null;
      const rows = listFor(ctx.state, a.user.id, ctx.now).filter((n) => !after || before(n, after));
      const items = rows.slice(0, NOTIFICATION_PAGE);
      const last = items.at(-1);
      const nextCursor = rows.length > NOTIFICATION_PAGE && last ? encodeCursor(last.createdAt, last.id) : null;
      return { body: { items: items.map(toNotification), nextCursor } };
    },
  }),

  route('GET', '/v1/notifications/unread-count', {
    action: 'self.view',
    async handler(ctx) {
      const a = authed(ctx);
      return { body: { count: listFor(ctx.state, a.user.id, ctx.now).filter((n) => n.readAt === null).length } };
    },
  }),

  route('POST', '/v1/notifications/read-all', {
    action: 'self.view',
    async handler(ctx) {
      const a = authed(ctx);
      const at = toIso(ctx.now);
      for (const n of ctx.state.notifications) if (n.userId === a.user.id && n.readAt === null) n.readAt = at;
      return { body: { count: 0 } };
    },
  }),

  route('POST', '/v1/notifications/:id/read', {
    action: 'self.view',
    async handler(ctx) {
      const a = authed(ctx);
      const n = ctx.state.notifications.find((x) => x.id === ctx.params.id && x.userId === a.user.id);
      if (!n) throw notFound();
      n.readAt ??= toIso(ctx.now);
      return { body: toNotification(n) };
    },
  }),

  route('POST', '/v1/notifications/push-token', {
    action: 'self.view',
    body: pushTokenBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { deviceId, token } = ctx.body;
      // One token per phone: a person switch on the same phone moves the token to the new person.
      ctx.state.devices = ctx.state.devices.filter((d) => d.deviceId !== deviceId && d.token !== token);
      ctx.state.devices.push({ userId: a.user.id, deviceId, token, updatedAt: toIso(ctx.now) });
      return { body: { deviceId } };
    },
  }),

  route('DELETE', '/v1/notifications/push-token/:deviceId', {
    action: 'self.view',
    async handler(ctx) {
      const a = authed(ctx);
      const { deviceId } = ctx.params;
      ctx.state.devices = ctx.state.devices.filter((d) => !(d.userId === a.user.id && d.deviceId === deviceId));
      return { body: { deviceId } };
    },
  }),
];
