import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useDisplayBasis, useMe } from '../api/hooks/me';
import { refreshNotifications } from '../api/hooks/notifications';
import { getTransport } from '../api/transport';
import { onSignOut, useSession } from '../auth/session';
import { requestSync } from '../offline/useSync';
import { localData, showLocal } from './localNotify';
import { openNotificationLink } from './openLink';
import { dismissWelcome } from '../onboarding/tourStore';
import { ensurePermission } from './permission';
import { getPushChannel } from './pushChannel';

// Sign-out says goodbye with the old credentials, in the background (F5 Ruling 7). The server
// also drops the phone when the session is revoked, so an offline sign-out loses nothing.
onSignOut(({ accessToken, deviceId }) => {
  if (!accessToken || !deviceId) return;
  void getTransport()
    .then((t) =>
      t.request({
        method: 'DELETE',
        path: `/v1/notifications/push-token/${encodeURIComponent(deviceId)}`,
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    )
    .catch(() => undefined);
});

/**
 * Push for the signed-in person (F5 Task 6): registers this phone, shows alerts as phone
 * notifications, turns silent pushes into a sync, and opens a tapped notification. Re-runs for
 * every new sign-in or person switch; the server keeps one person per phone.
 */
export function usePush(): void {
  const router = useRouter();
  const qc = useQueryClient();
  const status = useSession((s) => s.status);
  const identity = useSession((s) => s.identity);
  const deviceId = useSession((s) => s.deviceId);
  const { data: me } = useMe();
  const basis = useDisplayBasis();
  const basisRef = useRef(basis);
  basisRef.current = basis;
  const signedIn = status === 'signedIn' || status === 'locked';
  const userId = signedIn ? me?.id : undefined;

  useEffect(() => {
    if (!userId || !deviceId) return;
    let alive = true;
    let off: () => void = () => undefined;
    void (async () => {
      const channel = await getPushChannel();
      const token = channel.token(deviceId);
      if (!token || !alive) return;
      off = channel.subscribe(token, (m) => {
        if (m.type === 'sync') return requestSync();
        void refreshNotifications(qc);
        void showLocal(m.notification, basisRef.current).catch(() => undefined);
      });
      try {
        await api('/v1/notifications/push-token', { method: 'POST', body: { deviceId, token } });
      } catch {
        // Offline now: the next sign-in or app start registers again; the list still polls.
      }
      if (alive) void ensurePermission();
    })();
    return () => {
      alive = false;
      off();
    };
  }, [userId, deviceId, identity, qc]);

  useEffect(() => {
    if (!userId) return;
    const handled = new Set<string>();
    const open = (r: Notifications.NotificationResponse | null) => {
      const d = localData(r);
      if (!d || handled.has(d.notificationId)) return;
      handled.add(d.notificationId);
      // Someone else's notification after a person switch answers 404: nothing to mark.
      void api(`/v1/notifications/${d.notificationId}/read`, { method: 'POST' })
        .then(() => refreshNotifications(qc))
        .catch(() => undefined);
      dismissWelcome(); // the link opens now, not behind the greeting
      openNotificationLink(router, d.deepLink);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    // A tap that started the app (or a tap on Android's collapsed group) has no live event.
    void Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        open(r);
        return Notifications.clearLastNotificationResponseAsync();
      })
      .catch(() => undefined);
    return () => sub.remove();
  }, [userId, router, qc]);
}
