import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Preferences that belong to this phone, not to the user's account (the unit basis is per user and
 * lives on the server). Stored in AsyncStorage.
 */
export interface DevicePrefs {
  themeMode: 'light' | 'dark' | 'auto';
  textSize: 'normal' | 'large';
  fingerprint: boolean;
}

export const DEVICE_PREFS_KEY = 'tonnage.devicePrefs';

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  themeMode: 'auto',
  textSize: 'normal',
  fingerprint: false,
};

const THEME_MODES = ['light', 'dark', 'auto'] as const;
const TEXT_SIZES = ['normal', 'large'] as const;

/** Keeps only valid fields; anything unknown or malformed falls back to the default. */
function sanitize(raw: unknown): DevicePrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_DEVICE_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    themeMode: THEME_MODES.includes(r.themeMode as DevicePrefs['themeMode'])
      ? (r.themeMode as DevicePrefs['themeMode'])
      : DEFAULT_DEVICE_PREFS.themeMode,
    textSize: TEXT_SIZES.includes(r.textSize as DevicePrefs['textSize'])
      ? (r.textSize as DevicePrefs['textSize'])
      : DEFAULT_DEVICE_PREFS.textSize,
    fingerprint:
      typeof r.fingerprint === 'boolean' ? r.fingerprint : DEFAULT_DEVICE_PREFS.fingerprint,
  };
}

export async function getDevicePrefs(): Promise<DevicePrefs> {
  try {
    const raw = await AsyncStorage.getItem(DEVICE_PREFS_KEY);
    return raw === null ? { ...DEFAULT_DEVICE_PREFS } : sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DEVICE_PREFS };
  }
}

/** Drops keys whose value is `undefined`, so `{ themeMode: undefined }` never resets a setting. */
export function definedOnly(patch: Partial<DevicePrefs>): Partial<DevicePrefs> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<DevicePrefs>;
}

export function mergeDevicePrefs(current: DevicePrefs, patch: Partial<DevicePrefs>): DevicePrefs {
  return sanitize({ ...current, ...definedOnly(patch) });
}

// Every read-merge-write runs after the previous one, so two quick changes cannot overwrite each
// other (each would otherwise read the same old value).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export function setDevicePrefs(patch: Partial<DevicePrefs>): Promise<DevicePrefs> {
  return serial(async () => {
    const next = mergeDevicePrefs(await getDevicePrefs(), patch);
    await AsyncStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(next));
    return next;
  });
}
