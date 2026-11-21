import { type Notification, type UnitBasis, renderNotification } from '@tonnage/shared';
import * as Notifications from 'expo-notifications';

/** F5 Ruling 9: a push while the app is open still shows a banner, quietly. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** What a shown notification carries back when tapped. */
export interface LocalData {
  notificationId: string;
  deepLink: string;
}

/** Shows a notification on the phone now, in the person's unit basis (spec §5.6). */
export async function showLocal(n: Notification, basis: UnitBasis): Promise<void> {
  const { title, body } = renderNotification(n, basis);
  const data: LocalData = { notificationId: n.id, deepLink: n.deepLink };
  await Notifications.scheduleNotificationAsync({ content: { title, body, data: { ...data } }, trigger: null });
}

/** The tapped notification's data, if it is one of ours. */
export function localData(r: Notifications.NotificationResponse | null | undefined): LocalData | null {
  const d = r?.notification.request.content.data as Partial<LocalData> | undefined;
  return d && typeof d.notificationId === 'string' && typeof d.deepLink === 'string'
    ? { notificationId: d.notificationId, deepLink: d.deepLink }
    : null;
}
