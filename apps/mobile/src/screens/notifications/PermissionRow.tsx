import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';
import { usePermissionState } from '../../notifications/permission';
import { MenuRow } from '../../ui';

const VALUE = { granted: 'On', denied: 'Off — open phone settings', undetermined: 'Not set' } as const;

/**
 * Settings / Profile: whether this phone shows notifications (F5 Ruling 8). Off sends the person
 * to the phone's settings (the app may not ask twice); not set yet asks now.
 */
export function PermissionRow() {
  // Always a row (a Group draws dividers between elements, even empty ones); blank while reading.
  const state = usePermissionState();
  return (
    <MenuRow
      icon="bell"
      tone="bl"
      label="Phone notifications"
      value={state ? VALUE[state] : undefined}
      valueColor={state === 'denied' ? 'wnt' : undefined}
      accessibilityLabel={state ? `Phone notifications, ${VALUE[state]}` : 'Phone notifications'}
      onPress={() => {
        if (!state) return;
        if (state === 'undetermined') void Notifications.requestPermissionsAsync().catch(() => undefined);
        else void Linking.openSettings().catch(() => undefined);
      }}
    />
  );
}
