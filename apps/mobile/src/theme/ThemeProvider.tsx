import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import {
  DEFAULT_DEVICE_PREFS,
  type DevicePrefs,
  getDevicePrefs,
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [prefs, setPrefsState] = useState<DevicePrefs>(DEFAULT_DEVICE_PREFS);

  useEffect(() => {
    let alive = true;
    void getDevicePrefs().then((p) => {
      if (alive) setPrefsState(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setPrefs = useCallback(async (patch: Partial<DevicePrefs>) => {
    setPrefsState((p) => ({ ...p, ...patch })); // instant on screen
    setPrefsState(await setDevicePrefs(patch)); // then the persisted, sanitised value
  }, []);

  const value = useMemo<ThemeValue>(() => {
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

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
