// F2.11: Home dashboard and Orders list (canvas 02, 03, 38) on the demo seed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { OrdersScreen } from '../src/screens/orders/OrdersScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({}) }));

const NOW = Date.UTC(2026, 10, 3, 4, 30); // Tue 3 Nov 2026, 10:00 IST
const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
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

async function setup(seedOrders = true) {
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders });
  setTransport(null);
  setMockApi(mock);
  await signIn(ids.users.rajesh);
}

// Pin "now" for greetings, dates and ages without faking timers (search debounce needs real ones).
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await setup();
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

const noRupees = () => expect(screen.queryAllByText(/₹/)).toHaveLength(0);

describe('HomeScreen', () => {
  it('owner: greeting and IST date, pending across units with the per-company split, today tiles', async () => {
    await wrap(<HomeScreen />);
    expect(await screen.findByText('Good morning, Rajesh')).toBeOnTheScreen();
    expect(screen.getByText('Tuesday, 3 November')).toBeOnTheScreen();
    expect(await screen.findByText('191.600')).toBeOnTheScreen();
    expect(screen.getByText('3 open orders across 4 units')).toBeOnTheScreen();
    expect(screen.getByLabelText('Kalinga · KRM, 77.600 MT pending')).toBeOnTheScreen();
    expect(screen.getByLabelText('Booked today, 84.000 MT, 1 order, ₹38.64 L')).toBeOnTheScreen();
    expect(screen.getByLabelText('Dispatched today, 42.280 MT, 2 trucks')).toBeOnTheScreen();
  });

  it('the unit pill opens the switcher; Kalinga filters Home to KRM', async () => {
    await wrap(<HomeScreen />);
    await screen.findByText('191.600');
    await fireEvent.press(screen.getByRole('button', { name: 'Switch unit — All units' }));
    await fireEvent.press(await screen.findByRole('radio', { name: /^Kalinga Rolling Mills/ }));
    expect(await screen.findByRole('button', { name: 'Switch unit — Kalinga Rolling Mills' })).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByLabelText('Pending dispatch, 77.600 MT')).toBeOnTheScreen());
  });

  it('plant head (Kiran, AIP): AIP figures and not a single ₹', async () => {
    await signIn(ids.users.kiran);
    client.clear();
    await wrap(<HomeScreen />);
    expect(await screen.findByText('84.000')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByLabelText(/^Booked today/)).toBeOnTheScreen());
    noRupees();
  });
});

describe('OrdersScreen', () => {
  it('cards for every order, newest first; status chips with counts', async () => {
    await wrap(<OrdersScreen />);
    expect(await screen.findByRole('button', { name: /^SO-2611-0142, Open, Shubham Traders, Nagpur/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'All, 5' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open, 2' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Partial, 1' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Completed, 1' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Short closed, 1' })).toBeOnTheScreen();
    const partly = screen.getByRole('button', { name: /^SO-2611-0141, Partly dispatched/ });
    expect(within(partly).getByText('72.400')).toBeOnTheScreen();
    expect(within(partly).getByText('/ 120.000 MT')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^SO-2610-0131, Completed.*\+0\.240 over/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^SO-2610-0136, Short closed.*11\.800 closed/ })).toBeOnTheScreen();
  });

  it('a broker-only order reads "Customer not added yet"', async () => {
    await wrap(<OrdersScreen />);
    expect(await screen.findByRole('button', { name: /^SO-2610-0139, Open, Customer not added yet, broker order · Mittal Brokers/ })).toBeOnTheScreen();
  });

  it('the Short closed chip and a number search each narrow the list', async () => {
    await wrap(<OrdersScreen />);
    await screen.findByText('SO-2611-0142');
    await fireEvent.press(screen.getByRole('button', { name: 'Short closed, 1' }));
    await waitFor(() => expect(screen.queryByText('SO-2611-0142')).toBeNull());
    expect(screen.getByText('SO-2610-0136')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'All, 5' }));
    await fireEvent.changeText(screen.getByLabelText('Search orders'), '0141');
    await waitFor(() => expect(screen.queryByText('SO-2610-0136')).toBeNull(), { timeout: 3000 });
    expect(screen.getByText('SO-2611-0141')).toBeOnTheScreen();
  });

  it('opening a card goes to the order', async () => {
    await wrap(<OrdersScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^SO-2611-0141/ }));
    expect(mockRouter.push).toHaveBeenCalledWith(expect.stringMatching(/^\/orders\/[0-9a-f-]{36}$/));
  });

  it('plant head sees AIP orders only and no ₹', async () => {
    await signIn(ids.users.kiran);
    client.clear();
    await wrap(<OrdersScreen />);
    expect(await screen.findByText('SO-2611-0142')).toBeOnTheScreen();
    expect(screen.queryByText('SO-2611-0141')).toBeNull(); // KRM only
    noRupees();
  });

  it('first run: no orders yet, with Create first order and the setup checklist', async () => {
    client.clear();
    setMockApi(null);
    await setup(false);
    await wrap(<OrdersScreen />);
    expect(await screen.findByText('No orders yet')).toBeOnTheScreen();
    expect(screen.getByText('Getting set up · 4 of 4 done')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Create first order' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/new');
  });
});
