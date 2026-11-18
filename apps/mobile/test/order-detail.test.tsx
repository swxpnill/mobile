// F2.12: order detail and its sheets (canvas 04, 30, 31, 32) on the demo seed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { type Order, SAMPLE_WORLD, orderListSchema, orderSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { OrderDetailScreen } from '../src/screens/orders/OrderDetailScreen';
import { shareText } from '../src/screens/orders/shareText';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const NOW = Date.UTC(2026, 10, 3, 4, 30);
const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;
let nowSpy: jest.SpyInstance;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}

const wrap = (ui: ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>
            {ui}
            <ToastHost />
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

/** The demo order with this number, as the signed-in person sees it. */
async function orderNo(number: string): Promise<Order> {
  const list = await api(`/v1/orders?q=${number}`, { schema: orderListSchema });
  const id = list.items.find((o) => o.number === number)!.id;
  return api(`/v1/orders/${id}`, { schema: orderSchema });
}

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
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await signIn(ids.users.rajesh);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('OrderDetailScreen', () => {
  it('SO-2611-0141: status, customer, dispatched card, lines with pending, the loading truck', async () => {
    const o = await orderNo('SO-2611-0141');
    await wrap(<OrderDetailScreen id={o.id} />);
    expect(await screen.findByText('Patel Infra Projects')).toBeOnTheScreen();
    expect(screen.getByText('Partly dispatched')).toBeOnTheScreen();
    expect(screen.getByLabelText('Dispatched 72.400 of 120.000 MT')).toBeOnTheScreen();
    expect(screen.getByLabelText('Pending, 47.600 MT')).toBeOnTheScreen();
    expect(screen.getByLabelText('Trucks, 3 + 1 loading')).toBeOnTheScreen();
    expect(screen.getByText('TMT Fe500D · 16 mm · 12 m')).toBeOnTheScreen();
    expect(screen.getByText('28.400 of 40.000 MT · 11.600 pending')).toBeOnTheScreen();
    expect(screen.getByLabelText('CG 07 BR 8810, loading, tare 12.460 MT')).toBeOnTheScreen();
  });

  it('Review Focus 4: short close meets the loading truck, confirms it, then closes', async () => {
    const o = await orderNo('SO-2611-0141');
    await wrap(<OrderDetailScreen id={o.id} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Short close' }));
    expect(await screen.findByText('Short close 47.600 MT?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Stock not available' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Short close order' }));
    expect(await screen.findByText('CG 07 BR 8810 — loading, tare 12.460 MT')).toBeOnTheScreen();
    expect(screen.getByText('May be loading now')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel 1 truck and short close' }));
    expect(await screen.findByText(/^Short closed · Stock not available/)).toBeOnTheScreen();
    const after = await orderNo('SO-2611-0141');
    expect(after.status).toBe('short_closed');
    expect(after.subOrders[0]!.openTrucks).toEqual([]);
    // The owner can reopen it from the banner.
    await fireEvent.press(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(async () => expect((await orderNo('SO-2611-0141')).status).toBe('partly_dispatched'));
  });

  it('delete forever: counts, the button waits for the typed number, then it is gone', async () => {
    const o = await orderNo('SO-2611-0142');
    await wrap(<OrderDetailScreen id={o.id} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'More actions' }));
    await fireEvent.press(await screen.findByRole('button', { name: /^Delete forever/ }));
    expect(await screen.findByText('2 sub-orders and 4 order lines')).toBeOnTheScreen();
    const del = screen.getByRole('button', { name: 'Delete forever' });
    expect(del).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText(`Type ${o.number} to confirm`), ` ${o.number.toLowerCase()} `);
    expect(screen.getByRole('button', { name: 'Delete forever' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const list = await api('/v1/orders', { schema: orderListSchema });
    expect(list.items.some((x) => x.number === o.number)).toBe(false);
  });

  it('city staff: no Delete forever and no Reopen', async () => {
    await signIn(ids.users.priya);
    client.clear();
    const o = await orderNo('SO-2610-0136'); // short closed
    await wrap(<OrderDetailScreen id={o.id} />);
    expect(await screen.findByText(/^Short closed · Customer stopped lifting/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('button', { name: /^Activity history/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Delete forever/ })).toBeNull();
  });

  it('plant head: only their sub-order, no money, no actions', async () => {
    await signIn(ids.users.kiran);
    client.clear();
    const o = await orderNo('SO-2611-0142');
    await wrap(<OrderDetailScreen id={o.id} />);
    expect(await screen.findByText('Aarav Ispat Pvt Ltd')).toBeOnTheScreen();
    expect(screen.queryByText('Kalinga Rolling Mills')).toBeNull();
    expect(screen.queryAllByText(/₹/)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Short close' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('move 10 MT of the AIP 16 mm · 12 m line to Kalinga (the 12 mm · 12 m line is planned on CG 04 MK 2291)', async () => {
    const o = await orderNo('SO-2611-0142');
    await wrap(<OrderDetailScreen id={o.id} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'More actions' }));
    await fireEvent.press(await screen.findByRole('button', { name: /^Move quantity/ }));
    await fireEvent.press(await screen.findByRole('radio', { name: /^AIP · TMT Fe500D · 16 mm · 12 m/ }));
    await fireEvent.press(screen.getByRole('radio', { name: /^Kalinga Rolling Mills/ }));
    await fireEvent.changeText(screen.getByLabelText('Quantity to move'), '10');
    await fireEvent.press(screen.getByRole('button', { name: 'Move 10.000 MT' }));
    await waitFor(async () => {
      const after = await orderNo('SO-2611-0142');
      expect(after.subOrders[0]!.lines[2]!.orderedKg).toBe(10_000);
      expect(after.subOrders[1]!.lines.map((l) => l.orderedKg)).toEqual([30_000, 10_000]);
    });
  });

  it('Share on WhatsApp opens WhatsApp with the order summary', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const o = await orderNo('SO-2611-0141');
    await wrap(<OrderDetailScreen id={o.id} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Share on WhatsApp' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/wa\.me\/\?text=/)));
    expect(decodeURIComponent(open.mock.calls[0]![0].split('text=')[1]!)).toContain('SO-2611-0141');
    open.mockRestore();
  });
});

describe('shareText', () => {
  it('uses the business unit for outside parties (MT), whatever the sender reads in', async () => {
    const o = await orderNo('SO-2611-0141');
    const text = shareText(o, 'mt');
    expect(text).toContain('Order SO-2611-0141 · Patel Infra Projects');
    expect(text).toContain('Kalinga Rolling Mills (SO-2611-0141-A)');
    expect(text).toContain('TMT Fe500D · 16 mm · 12 m: 28.400 of 40.000 MT dispatched, 11.600 pending');
    expect(text).toContain('Pending 47.600 MT');
    expect(shareText(o, 'kg')).toContain('Pending 47,600 kg');
  });
});
