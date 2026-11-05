import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import {
  DEFAULT_DEVICE_PREFS,
  type DevicePrefs,
  getDevicePrefs,
  mergeDevicePrefs,
  setDevicePrefs,
} from '../prefs/device';
import { type ColorScheme, darkTokens, lightTokens, type Tokens } from './tokens';

export interface ThemeValue {
  t: Tokens;
  /** The user's choice. */
  mode: DevicePrefs['themeMode'];
  /** What is actually shown (auto resolved against the system). */
  scheme: ColorScheme;
  /** Text multiplier: 1, or 1.15 for "Large". */
  scale: 1 | 1.15;
  prefs: DevicePrefs;
  setPrefs(patch: Partial<DevicePrefs>): Promise<void>;
}

const ThemeContext = createContext<ThemeValue | null>(null);

/**
 * Renders nothing until the stored prefs are read, so the first visible frame already has the
 * user's theme and text size (the root layout keeps the splash up until `onReady`).
 */
export function ThemeProvider({
  children,
  onReady,
}: {
  children: ReactNode;
  onReady?: () => void;
}) {
  const system = useColorScheme();
  const [prefs, setPrefsState] = useState<DevicePrefs | null>(null);
  const current = useRef<DevicePrefs>(DEFAULT_DEVICE_PREFS);
  const readyCb = useRef(onReady);
  readyCb.current = onReady;

  useEffect(() => {
    let alive = true;
    void getDevicePrefs().then((p) => {
      if (!alive) return;
      current.current = p;
      setPrefsState(p);
      readyCb.current?.();
    });
    return () => {
      alive = false;
    };
  }, []);

  const setPrefs = useCallback(async (patch: Partial<DevicePrefs>) => {
    // The screen follows the latest choice at once; storage writes run in order behind it.
    const next = mergeDevicePrefs(current.current, patch);
    current.current = next;
    setPrefsState(next);
    try {
      await setDevicePrefs(patch);
    } catch {
      // Not saved (storage full or unavailable): keep the choice for this session rather than
      // snapping back, and never surface an unhandled rejection to fire-and-forget callers.
    }
  }, []);

  const value = useMemo<ThemeValue | null>(() => {
    if (!prefs) return null;
    const scheme: ColorScheme =
      prefs.themeMode === 'auto' ? (system === 'dark' ? 'dark' : 'light') : prefs.themeMode;
    return {
      t: scheme === 'dark' ? darkTokens : lightTokens,
      mode: prefs.themeMode,
      scheme,
      scale: prefs.textSize === 'large' ? 1.15 : 1,
      prefs,
      setPrefs,
    };
  }, [prefs, system, setPrefs]);

  if (!value) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
