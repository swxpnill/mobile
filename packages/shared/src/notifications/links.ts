import type { Role } from '../roles.ts';
import type { NotificationContent } from './kinds.ts';

/** Where tapping the notification goes, for this recipient (F5 plan Ruling 4). */
export function deepLinkFor(n: NotificationContent, role: Role): string {
  switch (n.kind) {
    case 'order.created':
    case 'order.over_tolerance':
    case 'order.short_closed':
      return `/orders/${n.data.orderId}`;
    case 'truck.weighed':
      return `/trucks/${n.data.truckId}`;
    case 'truck.dispatched':
      return role === 'supervisor' ? '/done' : `/trucks/${n.data.truckId}`;
    case 'truck.assigned':
      return role === 'supervisor' ? '/tasks' : `/trucks/${n.data.truckId}`;
    case 'orders.aged':
      return '/orders?aged=1';
    case 'broker.payment_recorded':
      return `/parties/${n.data.brokerId}`;
    case 'rejection.created':
      return '/attention';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED = new RegExp(`^(?:/(?:orders|trucks|parties)/${UUID}|/orders\\?aged=1|/tasks|/done|/attention|/notifications)$`);

/**
 * True only for the in-app routes a notification may open. A push payload is outside data:
 * the phone never navigates to anything else.
 */
export function isAllowedDeepLink(path: string): boolean {
  return ALLOWED.test(path);
}
