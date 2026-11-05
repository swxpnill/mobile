import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { type Me, SAMPLE_WORLD, type Transport, tokenPairSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { ME_CACHE_KEY, UnitBasisProvider, useUnitBasis } from '../src/api/hooks/me';
import { setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { RequireAction } from '../src/nav/guard';
import { firstTab, tabsForRole } from '../src/nav/tabs';
import { MoreScreen } from '../src/screens/MoreScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { QtyText, TabBar } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;
let patches = 0;

async function signInAs(mobile: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/request-code',
    headers: {},
    body: { mobile },
  });
  const res = await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/verify',
    headers: {},
    body: { mobile, code: '123456', deviceId },
  });
  await useSession.getState().signIn(tokenPairSchema.parse(res.body));
}

const wrap = (ui: ReactElement) =>
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>{ui}</UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)) });
  patches = 0;
  const counting: Transport = {
    request: (req) => {
      if (req.method === 'PATCH' && req.path === '/v1/me/preferences') patches += 1;
      return mock.transport.request(req);
    },
  };
  setTransport(counting);
  // gcTime Infinity: no 5-minute cache-cleanup timers keeping Jest alive after the last test.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(() => client.clear());

describe('tabsForRole', () => {
  it('owner and city staff get 5 tabs, plant head 4 (no New), supervisor 3', () => {
    expect(tabsForRole('owner')).toEqual(['home', 'orders', 'new', 'dispatch', 'more']);
    expect(tabsForRole('city_staff')).toEqual(['home', 'orders', 'new', 'dispatch', 'more']);
    expect(tabsForRole('plant_head')).toEqual(['home', 'orders', 'dispatch', 'more']);
    expect(tabsForRole('plant_head')).not.toContain('new');
    expect(tabsForRole('supervisor')).toEqual(['tasks', 'done', 'profile']);
    expect(firstTab('supervisor')).toBe('tasks');
  });
});

describe('TabBar', () => {
  it('supervisor sees My tasks / Done / Profile and no Orders tab; active tab is selected', async () => {
    const onPress = jest.fn();
    await wrap(<TabBar tabs={tabsForRole('supervisor')} active="tasks" onPress={onPress} />);
    expect(screen.getByRole('tab', { name: 'My tasks' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Done' })).not.toBeSelected();
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Orders' })).toBeNull();
    await fireEvent.press(screen.getByRole('tab', { name: 'Done' }));
    expect(onPress).toHaveBeenCalledWith('done');
  });

  it('owner bar has the five canvas labels in order', async () => {
    await wrap(<TabBar tabs={tabsForRole('owner')} active="home" onPress={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual([
      'Home',
      'Orders',
      'New',
      'Dispatch',
      'More',
    ]);
  });
});

describe('More', () => {
  it('owner: profile card with scope, admin rows, coming-soon masters, sign out', async () => {
    await signInAs('9826100012');
    await wrap(<MoreScreen />);
    expect(await screen.findByText('Rajesh Agrawal')).toBeOnTheScreen();
    expect(
      // The number is joined with non-breaking spaces so it never wraps mid-number.
      await screen.findByText('Owner · all 4 units · +91 98261 00012'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Companies & units' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Users & roles' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Customers & brokers, coming soon' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(useSession.getState().status).toBe('signedOut'));
  });

  it('city staff: no Companies & units or Users & roles; Settings still there', async () => {
    await signInAs('9826100013');
    await wrap(<MoreScreen />);
    expect(await screen.findByText('Priya Sharma')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Companies & units' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Users & roles' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeOnTheScreen();
  });

  it('plant head: no money rows (money is hidden from plant roles)', async () => {
    await signInAs('9826100018');
    await wrap(<MoreScreen />);
    expect(await screen.findByText('Kiran Rao')).toBeOnTheScreen();
    expect(await screen.findByText(/Plant head · Aarav · Siltara/)).toBeOnTheScreen();
    expect(screen.queryByText('Broker ledger')).toBeNull();
  });
});

describe('route guard', () => {
  it('deep link to an admin screen as supervisor redirects to /tasks', async () => {
    await signInAs('9826100014');
    await wrap(
      <RequireAction action="users.manage">
        <></>
      </RequireAction>,
    );
    expect(await screen.findByTestId('redirect')).toHaveTextContent('/tasks');
  });

  it('owner passes through', async () => {
    await signInAs('9826100012');
    const { Text } = jest.requireActual('react-native');
    await wrap(
      <RequireAction action="users.manage">
        <Text>Users</Text>
      </RequireAction>,
    );
    expect(await screen.findByText('Users')).toBeOnTheScreen();
  });
});

describe('unit basis', () => {
  it('switching to kg re-renders 24180 from "24.180 MT" to "24,180 kg" and PATCHes once; survives restart', async () => {
    await signInAs('9826100014');
    let setBasis: ((b: 'mt' | 'kg') => Promise<void>) | undefined;
    function Grab() {
      setBasis = useUnitBasis().setBasis;
      return null;
    }
    await wrap(
      <>
        <Grab />
        <QtyText kg={24180} withUnit />
      </>,
    );
    expect(await screen.findByText('24.180 MT')).toBeOnTheScreen();
    await setBasis!('kg');
    expect(await screen.findByText('24,180 kg')).toBeOnTheScreen();
    expect(patches).toBe(1);
    // Cached for an offline start.
    const cached = JSON.parse((await AsyncStorage.getItem(ME_CACHE_KEY)) ?? 'null') as Me | null;
    expect(cached?.preferences.unitBasis).toBe('kg');
  });

  it('Profile: supervisor sees plant and the Units control', async () => {
    await signInAs('9826100014');
    await wrap(<ProfileScreen />);
    expect(await screen.findByText('Ravi Verma')).toBeOnTheScreen();
    expect(await screen.findByText(/Aarav · Siltara/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'kg / ₹ per kg' }));
    await waitFor(() => expect(patches).toBe(1));
    expect(ids.users.ravi).toBeDefined();
  });
});

describe('sign-out clears cached data', () => {
  it('the cached profile is removed so the next user never sees it', async () => {
    await signInAs('9826100012');
    await wrap(<MoreScreen />);
    await screen.findByText('Rajesh Agrawal');
    expect(await AsyncStorage.getItem(ME_CACHE_KEY)).not.toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await AsyncStorage.getItem(ME_CACHE_KEY)).toBeNull());
    expect(client.getQueryData(['me'])).toBeUndefined();
  });
});
