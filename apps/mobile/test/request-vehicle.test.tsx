// Request vehicle (Task 4): the sheet (canvas 40) on the demo seed, signed in as Rajesh.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Linking } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { z } from 'zod';
import { type Order, SAMPLE_WORLD, activityEntrySchema, orderListSchema, orderSchema, partySchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetVehicleRequestQueueForTests } from '../src/offline/vehicleRequestQueue';
import { setDevicePrefs } from '../src/prefs/device';
import { RequestVehicleSheet } from '../src/screens/orders/RequestVehicleSheet';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { darkTokens, lightTokens } from '../src/theme/tokens';
import { ToastHost, hideToast } from '../src/ui';
import { auditA11y } from './a11y/audit';
import { collectColors, palette } from './palette';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const NOW = Date.UTC(2026, 10, 3, 4, 30);
const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;
let nowSpy: jest.SpyInstance;
let onClose: jest.Mock;

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

async function orderNo(number: string): Promise<Order> {
  const list = await api(`/v1/orders?q=${number}`, { schema: orderListSchema });
  const id = list.items.find((o) => o.number === number)!.id;
  return api(`/v1/orders/${id}`, { schema: orderSchema });
}

const requestsOf = async (orderId: string) =>
  (await api(`/v1/orders/${orderId}/activity`, { schema: z.array(activityEntrySchema) })).filter((e) => e.action === 'order.vehicle_requested');

const sheet = async (order: Order, extra: Partial<Parameters<typeof RequestVehicleSheet>[0]> = {}) => {
  await wrap(<RequestVehicleSheet order={order} visible onClose={onClose} {...extra} />);
  // The parties load before the numbers show.
  await screen.findAllByRole('radio', { name: /\+91/ });
};

const checked = (name: RegExp | string) => screen.getByRole('radio', { name }).props.accessibilityState?.checked;
const messageText = () => screen.getByLabelText('Message').props.value as string;

beforeAll(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterAll(() => nowSpy.mockRestore());

beforeEach(async () => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetVehicleRequestQueueForTests();
  hideToast();
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(ids.users.rajesh, deviceId));
  onClose = jest.fn();
  jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('RequestVehicleSheet', () => {
  it('broker order: header, both parties, R.K. Agarwal\'s WhatsApp number preselected, the canvas message', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    expect(screen.getByText('Request vehicle')).toBeOnTheScreen();
    expect(screen.getByText('SO-2611-0142 · Shubham Traders, Nagpur')).toBeOnTheScreen();
    expect(checked('R.K. Agarwal, Broker')).toBe(true);
    expect(checked('Shubham Traders, Customer')).toBe(false);
    expect(checked(/\+91 98261 00501/)).toBe(true);
    expect(screen.getByText('WhatsApp')).toBeOnTheScreen();
    expect(checked(/^All pending/)).toBe(true);
    // Everything pending: 24 + 10 + 10 (unplanned of 20) on AIP... as the server counts it, and 30 on KRM.
    const pendingKg = o.subOrders.flatMap((s) => s.lines).reduce((n, l) => n + l.pendingKg, 0);
    const total = `${(pendingKg / 1000).toFixed(3)} MT`;
    expect(screen.getByLabelText(`Total to request, ${total}`)).toBeOnTheScreen();
    expect(messageText()).toMatch(/^Namaste R\.K\. ji, please arrange a vehicle for order SO-2611-0142 \(Shubham Traders, Nagpur\):\n/);
    expect(messageText()).toContain('• TMT Fe500D 16 mm · 40 ft — 30.000 MT (Kalinga, Borai)');
    expect(messageText()).toContain(`Total ${total}. Please share vehicle number and driver phone.\n– Rajesh, Tonnage`);
    expect(screen.getByRole('button', { name: /Send on WhatsApp/ })).toBeEnabled();
  });

  it('customer-only order: the customer\'s number is preselected and there is no party switch', async () => {
    const o = await orderNo('SO-2611-0141');
    await sheet(o);
    expect(screen.queryByRole('radiogroup', { name: 'Party' })).toBeNull();
    expect(screen.getByText('Patel Infra Projects')).toBeOnTheScreen();
    expect(checked(/Hitesh Patel/)).toBe(true);
  });

  it('Review Focus 2: the landline is call only: Send on WhatsApp is disabled, Call still works', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    await fireEvent.press(screen.getByRole('radio', { name: 'Shubham Traders, Customer' }));
    expect(checked(/Suresh Jain.*98260 12345/)).toBe(true);
    await fireEvent.press(screen.getByRole('radio', { name: /71225 51234/ }));
    expect(screen.getByText('+91 71225 51234 · call only')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /Send on WhatsApp/ })).toBeDisabled();
    expect(messageText()).toMatch(/^Namaste Suresh ji,/);
    await fireEvent.press(screen.getByRole('button', { name: 'Call Suresh Jain' }));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('tel:+917122551234'));
    await waitFor(async () => expect(await requestsOf(o.id)).toHaveLength(1));
  });

  it('Send on WhatsApp opens wa.me with the encoded message, records one request and closes', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    const text = messageText();
    await fireEvent.press(screen.getByRole('button', { name: /Send on WhatsApp/ }));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith(`https://wa.me/919826100501?text=${encodeURIComponent(text)}`));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findByText('Request recorded')).toBeOnTheScreen();
    const rows = await requestsOf(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ channel: 'whatsapp', contactName: 'R.K. Agarwal' });
  });

  it('Call dials the number and records the call channel', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    await fireEvent.press(screen.getByRole('button', { name: 'Call R.K. Agarwal' }));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('tel:+919826100501'));
    await waitFor(async () => expect((await requestsOf(o.id))[0]?.meta).toMatchObject({ channel: 'call' }));
  });

  it('Ruling 8: WhatsApp missing: a toast, nothing opened, nothing recorded, the sheet stays', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    await fireEvent.press(screen.getByRole('button', { name: /Send on WhatsApp/ }));
    expect(await screen.findByText("WhatsApp isn't installed")).toBeOnTheScreen();
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await requestsOf(o.id)).toHaveLength(0);
  });

  it('offline: the request is saved to send later', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    mock.controls.setOffline(true);
    await fireEvent.press(screen.getByRole('button', { name: /Send on WhatsApp/ }));
    expect(await screen.findByText('Request saved · will send when online')).toBeOnTheScreen();
    expect(Linking.openURL).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Copy puts the message on the clipboard and says so', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    await fireEvent.press(screen.getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(messageText()));
    expect(await screen.findByText('Copied')).toBeOnTheScreen();
  });

  it('Pick lines: a typed quantity above pending is clamped, an empty one unticks its line, the total follows', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    await fireEvent.press(screen.getByRole('radio', { name: /^Pick lines/ }));
    const krm = screen.getByLabelText('MT for TMT Fe500D · 16 mm · 40 ft');
    expect(krm.props.value).toBe('30.000');
    await fireEvent.changeText(krm, '35');
    expect(screen.getByLabelText('MT for TMT Fe500D · 16 mm · 40 ft').props.value).toBe('30.000');
    await fireEvent.changeText(krm, '12.5');
    expect(screen.getByText('30.000 MT pending · asking part')).toBeOnTheScreen();
    for (const field of screen.getAllByLabelText(/^MT for /)) {
      if (field !== screen.getByLabelText('MT for TMT Fe500D · 16 mm · 40 ft')) await fireEvent.changeText(field, '');
    }
    expect(screen.getByLabelText('Total to request, 12.500 MT')).toBeOnTheScreen();
    expect(screen.getAllByRole('checkbox').filter((c) => c.props.accessibilityState?.checked)).toHaveLength(1);
    expect(messageText()).toContain('— 12.500 MT (Kalinga, Borai)\nTotal 12.500 MT.');
  });

  it('One company lists the open sub-orders and asks for just that one', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    expect(screen.getByRole('radio', { name: /^One company, AIP or KRM/ })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: /^One company/ }));
    await fireEvent.press(screen.getByRole('radio', { name: /^KRM/ }));
    expect(screen.getByLabelText('Total to request, 30.000 MT')).toBeOnTheScreen();
    expect(messageText()).not.toContain('Aarav');
  });

  it('Review Focus 1: an edited message is kept; a later change offers Update message', async () => {
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'My own words');
    await fireEvent.press(screen.getByRole('radio', { name: /^One company/ }));
    expect(messageText()).toBe('My own words');
    await fireEvent.press(screen.getByRole('button', { name: 'Update message' }));
    expect(messageText()).toMatch(/^Namaste R\.K\. ji/);
    expect(screen.queryByRole('button', { name: 'Update message' })).toBeNull();
  });

  it('Review Focus 3: on the kg basis the inputs show kg and the message stays in MT', async () => {
    await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
    const o = await orderNo('SO-2611-0142');
    await sheet(o);
    expect((await screen.findAllByText(/ kg$/)).length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole('radio', { name: /^Pick lines/ }));
    expect(screen.getByLabelText('kg for TMT Fe500D · 16 mm · 40 ft').props.value).toBe('30,000');
    expect(screen.getByText('30,000 kg pending')).toBeOnTheScreen();
    expect(messageText()).toContain('— 30.000 MT (Kalinga, Borai)');
  });

  it('a prefill restores the number, lines and kg', async () => {
    const o = await orderNo('SO-2611-0142');
    const prefill = o.vehicleRequests[0]!;
    await sheet(o, { prefill });
    expect(checked(/^Pick lines/)).toBe(true);
    expect(checked(/\+91 98261 00501/)).toBe(true);
    expect(screen.getByLabelText(`Total to request, ${(prefill.totalKg / 1000).toFixed(3)} MT`)).toBeOnTheScreen();
  });

  it('Review Focus 5: with every line dispatched it says so and both actions are disabled', async () => {
    const o = await orderNo('SO-2611-0142');
    const done: Order = {
      ...o,
      subOrders: o.subOrders.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, pendingKg: 0 })), totals: { ...s.totals, pendingKg: 0 } })),
    };
    await sheet(done);
    expect(screen.getByText('Nothing pending on this order')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /Send on WhatsApp/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Call R.K. Agarwal' })).toBeDisabled();
  });

  it('a party with no number: "No number saved" with Add a number', async () => {
    const o = await orderNo('SO-2611-0142');
    const p = await api(`/v1/parties/${o.customer!.id}`, { schema: partySchema });
    const { type, name, gstin, city, defaultCommissionPerMt, paymentTermsText, isSelfTransporter, addresses, version, active } = p;
    await api(`/v1/parties/${p.id}`, {
      method: 'PATCH',
      body: { type, name, gstin, city, defaultCommissionPerMt: defaultCommissionPerMt ?? null, paymentTermsText, isSelfTransporter, addresses, contacts: [], version, active },
    });
    await sheet(o);
    await fireEvent.press(screen.getByRole('radio', { name: 'Shubham Traders, Customer' }));
    expect(screen.getByText('No number saved')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add a number' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/parties/form?id=${o.customer!.id}`);
    expect(screen.getByRole('button', { name: /^Call/ })).toBeDisabled();
  });

  describe.each(['light', 'dark'] as const)('%s theme', (scheme) => {
    it('passes the a11y audit and paints only palette colours', async () => {
      await setDevicePrefs({ themeMode: scheme });
      const o = await orderNo('SO-2611-0142');
      await sheet(o);
      await fireEvent.press(screen.getByRole('radio', { name: /^Pick lines/ }));
      const tree = screen.toJSON() as ReactTestRendererJSON;
      expect(auditA11y(tree)).toEqual([]);
      const t = scheme === 'dark' ? darkTokens : lightTokens;
      const used = collectColors(tree);
      expect(used.has(t.wa)).toBe(true);
      const allowed = palette(scheme);
      expect([...used].filter(([c]) => !allowed.has(c)).map(([c, where]) => `${c} (${where})`)).toEqual([]);
    });
  });
});
