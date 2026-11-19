// F5 Task 8: every colour on screen comes from the active palette (Graphite dark and light).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { setDevicePrefs } from '../src/prefs/device';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { CreateSheet } from '../src/screens/create/CreateSheet';
import { DispatchScreen } from '../src/screens/dispatch/DispatchScreen';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { MoreScreen } from '../src/screens/MoreScreen';
import { NotificationsScreen } from '../src/screens/notifications/NotificationsScreen';
import { OrdersScreen } from '../src/screens/orders/OrdersScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { type ColorScheme, darkTokens, lightTokens, unitBarColor, unitTagColors } from '../src/theme/tokens';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => ({}),
    useFocusEffect: () => undefined,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn(), reset: jest.fn() }),
    Redirect: ({ href }: { href: string }) => <Text>{href}</Text>,
  };
});

const NOW = Date.UTC(2026, 10, 19, 6, 0);
const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;

/** Every colour the palette may paint with, for one scheme. */
function palette(scheme: ColorScheme): Set<string> {
  const t = scheme === 'dark' ? darkTokens : lightTokens;
  const out = new Set<string>([...Object.values(t), 'transparent', 'none', 'currentColor']);
  for (let slot = 0; slot < 4; slot++) {
    const c = unitTagColors(slot, scheme);
    out.add(c.bg).add(c.fg).add(unitBarColor(slot, scheme));
  }
  return out;
}

const COLOR_KEYS = ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor', 'shadowColor', 'tintColor', 'textShadowColor'];
const PROP_KEYS = ['color', 'stroke', 'fill', 'placeholderTextColor', 'selectionColor', 'tintColor', 'trackColor', 'thumbColor'];

/** Colours used anywhere in the rendered tree, with where they were found. */
function collectColors(node: ReactTestRendererJSON | ReactTestRendererJSON[] | null, out = new Map<string, string>()): Map<string, string> {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectColors(n, out);
    return out;
  }
  const props = node.props as Record<string, unknown>;
  const style = StyleSheet.flatten(props.style as never) as Record<string, unknown> | undefined;
  for (const k of COLOR_KEYS) if (typeof style?.[k] === 'string') out.set(style[k] as string, `${node.type}.style.${k}`);
  for (const k of PROP_KEYS) if (typeof props[k] === 'string') out.set(props[k] as string, `${node.type}.${k}`);
  for (const child of node.children ?? []) if (typeof child !== 'string') collectColors(child, out);
  return out;
}

const wrap = (ui: ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>{ui}</UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}

let nowSpy: jest.SpyInstance;
beforeAll(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterAll(() => nowSpy.mockRestore());

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetUnitFilterForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

const SCREENS: { name: string; user: string; ui: () => ReactElement; ready: string | RegExp }[] = [
  { name: 'Home', user: ids.users.rajesh, ui: () => <HomeScreen />, ready: 'In plant now' },
  { name: 'Orders', user: ids.users.rajesh, ui: () => <OrdersScreen />, ready: /orders$/ },
  { name: 'Dispatch', user: ids.users.rajesh, ui: () => <DispatchScreen />, ready: 'Dispatch' },
  { name: 'More', user: ids.users.rajesh, ui: () => <MoreScreen />, ready: 'Needs attention' },
  { name: 'Settings', user: ids.users.rajesh, ui: () => <SettingsScreen />, ready: 'Appearance' },
  { name: 'Notifications', user: ids.users.rajesh, ui: () => <NotificationsScreen />, ready: 'Notifications' },
  { name: 'Create sheet', user: ids.users.rajesh, ui: () => <CreateSheet visible onClose={jest.fn()} />, ready: 'Create new' },
  { name: 'Profile (supervisor)', user: ids.users.ravi, ui: () => <ProfileScreen />, ready: 'Notifications' },
];

describe.each(['dark', 'light'] as const)('%s theme: only palette colours', (scheme) => {
  it.each(SCREENS.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    await setDevicePrefs({ themeMode: scheme });
    await signIn(s.user);
    await wrap(s.ui());
    expect((await screen.findAllByText(s.ready)).length).toBeGreaterThan(0);
    const allowed = palette(scheme);
    const used = collectColors(screen.toJSON());
    const t = scheme === 'dark' ? darkTokens : lightTokens;
    // The walk really sees the screen: its text colour is there.
    expect(used.has(t.tx) || used.has(t.tx2)).toBe(true);
    const stray = [...used].filter(([c]) => !allowed.has(c)).map(([c, where]) => `${c} (${where})`);
    expect(stray).toEqual([]);
  });
});
