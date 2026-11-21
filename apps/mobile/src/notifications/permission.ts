import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** Set once the system prompt has been shown on this phone (F5 Ruling 8: ask once). */
export const ASKED_KEY = 'tonnage.notificationPermissionAsked';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

const stateOf = (p: Notifications.NotificationPermissionsStatus): PermissionState =>
  p.granted ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined';

/**
 * Asks for permission at most once per phone, after sign-in. A refusal is respected; the list
 * and badge work without it. Never throws.
 */
export async function ensurePermission(): Promise<PermissionState> {
  try {
    const now = stateOf(await Notifications.getPermissionsAsync());
    if (now !== 'undetermined') return now;
    if ((await AsyncStorage.getItem(ASKED_KEY)) === '1') return now;
    await AsyncStorage.setItem(ASKED_KEY, '1');
    return stateOf(await Notifications.requestPermissionsAsync());
  } catch {
    return 'undetermined';
  }
}

/** The current permission, read again whenever the app returns from the phone's settings. */
export function usePermissionState(): PermissionState | null {
  const [state, setState] = useState<PermissionState | null>(null);
  const read = useCallback(() => {
    Notifications.getPermissionsAsync()
      .then((p) => setState(stateOf(p)))
      .catch(() => setState(null));
  }, []);
  useEffect(() => {
    read();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && read());
    return () => sub.remove();
  }, [read]);
  return state;
}
