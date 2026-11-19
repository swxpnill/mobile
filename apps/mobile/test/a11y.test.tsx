// F5 Task 10: every screen passes the TalkBack audit (names, roles, 44 dp targets, a header).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, orderListSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { CompaniesScreen } from '../src/screens/admin/CompaniesScreen';
import { UsersScreen } from '../src/screens/admin/UsersScreen';
import { NeedsAttentionScreen } from '../src/screens/attention/NeedsAttentionScreen';
import { CreateSheet } from '../src/screens/create/CreateSheet';
import { LoadingPickerScreen } from '../src/screens/create/LoadingPickerScreen';
import { DispatchScreen } from '../src/screens/dispatch/DispatchScreen';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { BrokerDuesScreen } from '../src/screens/money/BrokerDuesScreen';
import { MoreScreen } from '../src/screens/MoreScreen';
import { WizardScreen } from '../src/screens/new-order/WizardScreen';
import { NotificationsScreen } from '../src/screens/notifications/NotificationsScreen';
import { OrderDetailScreen } from '../src/screens/orders/OrderDetailScreen';
import { OrdersScreen } from '../src/screens/orders/OrdersScreen';
import { PartiesScreen } from '../src/screens/parties/PartiesScreen';
import { ProductsScreen } from '../src/screens/products/ProductsScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { ReportsScreen } from '../src/screens/reports/ReportsScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { SignInScreen } from '../src/screens/SignInScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { auditA11y } from './a11y/audit';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true, setParams: jest.fn() };
jest.mock('expo-router', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => ({}),
    useFocusEffect: () => undefined,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn(), reset: jest.fn() }),
    Redirect: ({ href }: { href: string }) => <T>{href}</T>,
    Link: ({ children }: { children: ReactElement }) => children,
  };
});

const NOW = Date.UTC(2026, 10, 19, 6, 0);
const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;

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

describe('auditA11y', () => {
  const tree = async (ui: ReactElement) => (await render(ui)).toJSON() as ReactTestRendererJSON;

  it('flags an unnamed icon button, a missing role and a small target', async () => {
    const issues = auditA11y(
      await tree(
        <View>
          <Pressable onPress={() => undefined} style={{ width: 32, height: 32 }} accessibilityRole="button" />
          <Pressable onPress={() => undefined}>
            <Text>Save</Text>
          </Pressable>
        </View>,
      ),
    );
    expect(issues.map((i) => i.rule).sort()).toEqual(['header', 'name', 'role', 'target', 'target']);
  });

  it('hit slop makes up a small box; a named, roled, 44 dp button with a header passes', async () => {
    const issues = auditA11y(
      await tree(
        <View>
          <Text accessibilityRole="header">Title</Text>
          <Pressable onPress={() => undefined} hitSlop={6} style={{ width: 32, height: 32 }} accessibilityRole="button" accessibilityLabel="Close" />
          <Pressable onPress={() => undefined} style={{ minHeight: 44 }} accessibilityRole="button">
            <Text>Save</Text>
          </Pressable>
        </View>,
      ),
    );
    expect(issues).toEqual([]);
  });
});

const firstOrderId = async () => (await api('/v1/orders?status=all', { schema: orderListSchema })).items[0]!.id;

const OWNER: [string, () => Promise<ReactElement>][] = [
  ['Home', async () => <HomeScreen />],
  ['Orders', async () => <OrdersScreen />],
  ['Order detail', async () => <OrderDetailScreen id={await firstOrderId()} />],
  ['New order', async () => <WizardScreen />],
  ['Dispatch', async () => <DispatchScreen />],
  ['More', async () => <MoreScreen />],
  ['Parties', async () => <PartiesScreen />],
  ['Products', async () => <ProductsScreen />],
  ['Broker ledger', async () => <BrokerDuesScreen />],
  ['Reports', async () => <ReportsScreen />],
  ['Settings', async () => <SettingsScreen />],
  ['Users', async () => <UsersScreen />],
  ['Companies', async () => <CompaniesScreen />],
  ['Needs attention', async () => <NeedsAttentionScreen />],
  ['Notifications', async () => <NotificationsScreen />],
  ['Loading picker', async () => <LoadingPickerScreen />],
];

describe('owner screens', () => {
  it.each(OWNER)('%s', async (_name, ui) => {
    await signIn(ids.users.rajesh);
    await wrap(await ui());
    await waitFor(() => expect(screen.queryAllByLabelText('Loading')).toHaveLength(0), { timeout: 5000 });
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });

  it('Create new sheet', async () => {
    await signIn(ids.users.rajesh);
    await wrap(<CreateSheet visible onClose={jest.fn()} />);
    await screen.findByText('Create new');
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });
});

describe('supervisor and sign-in screens', () => {
  it.each([
    // Tasks, capture and Done today read the phone's device store, which needs the sync loop
    // (test/supervisor.test.tsx); Profile is the supervisor screen that stands alone.
    ['Profile', () => <ProfileScreen />],
  ] as const)('%s', async (_name, ui) => {
    await signIn(ids.users.ravi);
    await wrap(ui());
    await waitFor(() => expect(screen.queryAllByLabelText('Loading')).toHaveLength(0), { timeout: 5000 });
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });

  it('Sign in', async () => {
    await wrap(<SignInScreen />);
    await screen.findAllByRole('header');
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });
});
