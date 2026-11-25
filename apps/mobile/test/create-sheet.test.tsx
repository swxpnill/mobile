// Board 39: the Create new sheet (from the New tab) and its Loading picker, on the demo seed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { type Action, type Order, orderListSchema, orderSchema, SAMPLE_WORLD, can } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { api } from '../src/api/client';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { CreateSheet } from '../src/screens/create/CreateSheet';
import { CREATE_OPTIONS, createOptionsFor } from '../src/screens/create/createOptions';
import { LoadingPickerScreen } from '../src/screens/create/LoadingPickerScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';

let mockParams: Record<string, string> = {};
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));

const NOW = Date.UTC(2026, 10, 3, 4, 30);
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

async function setup({ seedOrders = true, userId = ids.users.rajesh as string }: { seedOrders?: boolean; userId?: string } = {}) {
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders });
  setTransport(null);
  setMockApi(mock);
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
  mockParams = {};
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetUnitFilterForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

const TILES = ['Order', 'Loading', 'Customer', 'Broker', 'Product', 'Transporter'];
const tile = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}\\. `) });

describe('Create new sheet', () => {
  it('owner: header, the six tiles in canvas order, and a labelled close button', async () => {
    await setup();
    await wrap(<CreateSheet visible onClose={jest.fn()} />);
    expect(await screen.findByText('Create new')).toBeOnTheScreen();
    expect(screen.getByText('What do you want to add?')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Close' })).toBeOnTheScreen(); // the ✕ (the backdrop sits behind the modal view)
    const labels = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel as string).filter((l) => l !== 'Close');
    expect(labels).toEqual([
      'Order. Book material across companies',
      'Loading. Truck against an open order',
      'Customer. Bill-to, ship-to, contacts',
      'Broker. Commission per MT, contacts',
      'Product. Size, lengths, conversion',
      'Transporter. Name, contact numbers',
    ]);
  });

  it.each([
    ['Order', '/order-form'],
    ['Loading', '/pick-loading'],
    ['Customer', { pathname: '/parties/form', params: { type: 'customer' } }],
    ['Broker', { pathname: '/parties/form', params: { type: 'broker' } }],
    ['Product', '/products/form'],
    ['Transporter', { pathname: '/parties/form', params: { type: 'transporter' } }],
  ])('%s closes the sheet and opens its screen', async (label, href) => {
    await setup();
    const onClose = jest.fn();
    await wrap(<CreateSheet visible onClose={onClose} />);
    await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${label}\\. `) }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith(href);
  });

  it('city staff see all six', async () => {
    await setup({ userId: ids.users.priya });
    await wrap(<CreateSheet visible onClose={jest.fn()} />);
    await screen.findByText('Create new');
    await waitFor(() => TILES.forEach((l) => expect(tile(l)).toBeOnTheScreen()));
  });

  it('tiles are hidden when the role lacks the action', () => {
    const without = (missing: Action) => createOptionsFor((a) => a !== missing).map((o) => o.label);
    expect(without('truck.assign')).toEqual(['Order', 'Customer', 'Broker', 'Product', 'Transporter']);
    expect(without('order.create')).toEqual(['Loading', 'Customer', 'Broker', 'Product', 'Transporter']);
    expect(without('masters.manage')).toEqual(['Order', 'Loading']);
    expect(createOptionsFor((a) => can('plant_head', a))).toEqual([]);
    expect(createOptionsFor((a) => can('supervisor', a))).toEqual([]);
    expect(createOptionsFor((a) => can('city_staff', a))).toHaveLength(CREATE_OPTIONS.length);
  });

  it('a plant head who reaches the sheet sees no tiles', async () => {
    await setup({ userId: ids.users.kiran });
    await wrap(<CreateSheet visible onClose={jest.fn()} />);
    await screen.findByText('Create new');
    await waitFor(() => expect(screen.queryByText('Order')).toBeNull());
    TILES.forEach((l) => expect(screen.queryByRole('button', { name: new RegExp(`^${l}\\. `) })).toBeNull());
  });

  it('the ✕, the backdrop and Android Back close it', async () => {
    await setup();
    const onClose = jest.fn();
    await wrap(<CreateSheet visible onClose={onClose} />);
    await screen.findByText('Create new');
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    await fireEvent(screen.getByTestId('sheet-modal'), 'requestClose');
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('Loading picker', () => {
  /** Every seeded order with its sub-orders, as the owner sees them. */
  async function allOrders(): Promise<Order[]> {
    const list = await api('/v1/orders?status=all&limit=50', { schema: orderListSchema });
    return Promise.all(list.items.map((o) => api(`/v1/orders/${o.id}`, { schema: orderSchema })));
  }

  it('lists only open or partly dispatched sub-orders, with company tag, party and pending', async () => {
    await setup();
    const orders = await allOrders();
    const subs = orders.flatMap((o) => o.subOrders.map((s) => ({ o, s })));
    const loadable = subs.filter(({ s }) => s.status === 'open' || s.status === 'partly_dispatched');
    const closed = subs.filter(({ s }) => s.status !== 'open' && s.status !== 'partly_dispatched');
    expect(loadable.length).toBeGreaterThan(0);
    expect(closed.length).toBeGreaterThan(0); // the seed has completed / short-closed ones to leave out

    await wrap(<LoadingPickerScreen />);
    for (const { s } of loadable) {
      const row = await screen.findByRole('button', { name: new RegExp(`^${s.number.replace(/[/.]/g, '\\$&')}, unit ${s.companyCode}, `) });
      expect(within(row).getByText(s.number)).toBeOnTheScreen();
      expect(within(row).getByLabelText(`Unit ${s.companyCode}`)).toBeOnTheScreen();
      expect(row.props.accessibilityLabel).toMatch(/ MT pending$/);
    }
    for (const { s } of closed) expect(screen.queryByText(s.number)).toBeNull();
  });

  it('a row opens Assign vehicle for that sub-order', async () => {
    await setup();
    const { o, s } = (await allOrders())
      .flatMap((o) => o.subOrders.map((s) => ({ o, s })))
      .find(({ s }) => s.status === 'open' || s.status === 'partly_dispatched')!;
    await wrap(<LoadingPickerScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${s.number.replace(/[/.]/g, '\\$&')}, `) }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/assign/[subOrderId]', params: { subOrderId: s.id, orderId: o.id } });
  });

  it('follows the unit switcher', async () => {
    await setup();
    await wrap(<LoadingPickerScreen />);
    await screen.findAllByRole('button', { name: / pending$/ });
    await fireEvent.press(screen.getByRole('button', { name: 'Switch unit — All units' }));
    await fireEvent.press(await screen.findByRole('radio', { name: /^Kalinga Rolling Mills/ }));
    await waitFor(() => {
      const rows = screen.getAllByRole('button', { name: / pending$/ });
      rows.forEach((r) => expect(r.props.accessibilityLabel).toContain('unit KRM'));
    });
  });

  it('search narrows the list', async () => {
    await setup();
    await wrap(<LoadingPickerScreen />);
    const before = (await screen.findAllByRole('button', { name: / pending$/ })).length;
    await fireEvent.changeText(screen.getByPlaceholderText('Search order no., party'), 'zzzz-nothing');
    expect(await screen.findByText('No open orders match')).toBeOnTheScreen();
    expect(before).toBeGreaterThan(0);
  });

  describe('request mode (?mode=request)', () => {
    beforeEach(() => {
      mockParams = { mode: 'request' };
    });

    it('is titled for the request and lists one row per order with something pending', async () => {
      await setup();
      const orders = await allOrders();
      const pendingOrders = orders.filter((o) =>
        o.subOrders.some((s) => (s.status === 'open' || s.status === 'partly_dispatched') && s.totals.pendingKg > 0),
      );
      const noPending = orders.filter((o) => !pendingOrders.includes(o));
      expect(noPending.length).toBeGreaterThan(0);
      await wrap(<LoadingPickerScreen />);
      expect(await screen.findByText('Request vehicle · pick an order')).toBeOnTheScreen();
      for (const o of pendingOrders) {
        const row = await screen.findByRole('button', { name: new RegExp(`^${o.number}, `) });
        expect(row.props.accessibilityLabel).toMatch(/ MT pending$/);
      }
      expect(screen.getAllByRole('button', { name: / pending$/ })).toHaveLength(pendingOrders.length);
      for (const o of noPending) expect(screen.queryByText(o.number)).toBeNull();
    });

    it('tapping SO-2611-0141 opens the request sheet for it, without leaving the picker', async () => {
      await setup();
      await wrap(<LoadingPickerScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: /^SO-2611-0141, / }));
      expect(await screen.findByText('Send to')).toBeOnTheScreen();
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(screen.getByText('Request vehicle · pick an order')).toBeOnTheScreen();
    });

    it('speaks of asking for a vehicle, not loading', async () => {
      await setup();
      await wrap(<LoadingPickerScreen />);
      expect(await screen.findByText('Choose the order to ask a vehicle for.')).toBeOnTheScreen();
      expect(screen.queryByText('Choose the open order to load a truck against.')).toBeNull();
    });

    it('nothing pending: its own empty state', async () => {
      await setup({ seedOrders: false });
      await wrap(<LoadingPickerScreen />);
      expect(await screen.findByText('Nothing pending')).toBeOnTheScreen();
      expect(screen.getByText('Every open order is fully dispatched or already closed.')).toBeOnTheScreen();
      expect(screen.queryByText(/Trucks are loaded against/)).toBeNull();
    });
  });

  it('no open orders: empty state with Create order', async () => {
    await setup({ seedOrders: false });
    await wrap(<LoadingPickerScreen />);
    expect(await screen.findByText('No open orders')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Create order' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/order-form');
  });
});
