import { isAllowedDeepLink } from '@tonnage/shared';
import type { Href } from 'expo-router';

/**
 * Opens a notification's target. A push payload is data from outside the app: only the routes
 * shared `isAllowedDeepLink` lists are followed; anything else opens the list (F5 Ruling 4).
 */
export function openNotificationLink(router: { push(href: Href): void }, deepLink: string | undefined): void {
  router.push((deepLink && isAllowedDeepLink(deepLink) ? deepLink : '/notifications') as Href);
}
