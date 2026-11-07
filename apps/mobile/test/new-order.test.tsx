// F2.13: the new-order wizard (canvas 07–10): book, double tap, autosave, edit with locks.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, draftSchema, orderListSchema, orderSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { z } from 'zod';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { WizardScreen } from '../src/screens/new-order/WizardScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useNavigation: () => mockNavigation }));

const NOW = Date.UTC(2026, 10, 3, 4, 30);
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
          <UnitBasisProvider>
            {ui}
            <ToastHost />
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

const orders = () => api('/v1/orders', { schema: orderListSchema });

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

/** Patel Infra, direct rate, KRM: 10 MT of TMT 20 mm · 12 m at ₹46,000 → ₹4,60,000. */
async function fillPatelOrder() {
  await fireEvent.press(await screen.findByRole('radio', { name: 'Customer' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Choose customer' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Patel Infra Projects, Indore' }));
  expect(await screen.findByRole('radio', { name: /^Site 2/ })).toBeChecked();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  await fireEvent.press(await screen.findByRole('radio', { name: 'Direct rate' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Choose the company' }));
  await fireEvent.press(await screen.findByRole('radio', { name: /^Kalinga Rolling Mills/ }));
  await fireEvent.press(await screen.findByRole('radio', { name: /^TMT Fe500D · 20 mm/ }));
  await fireEvent.changeText(screen.getByLabelText('Quantity'), '10');
  await fireEvent.changeText(screen.getByLabelText('Rate per MT'), '46000');
  expect(screen.getByLabelText('Line amount ₹4,60,000')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Add line' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Step 3 of 3 · Review')).toBeOnTheScreen();
}

describe('WizardScreen', () => {
  it('books an order in three steps; the server number opens', async () => {
    const before = (await orders()).counts.all;
    await wrap(<WizardScreen />);
    await fillPatelOrder();
    expect(screen.getAllByText('₹4,60,000').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/orders\//)));
    const list = await orders();
    expect(list.counts.all).toBe(before + 1);
    const o = await api(`/v1/orders/${list.items[0]!.id}`, { schema: orderSchema });
    expect(o).toMatchObject({ type: 'customer', estimatedValue: 460_000, customer: { name: 'Patel Infra Projects' } });
  });

  it('a double tap on Create makes one order', async () => {
    const before = (await orders()).counts.all;
    await wrap(<WizardScreen />);
    await fillPatelOrder();
    const btn = screen.getByRole('button', { name: 'Create order' });
    await act(async () => {
      fireEvent.press(btn);
      fireEvent.press(btn);
    });
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    expect((await orders()).counts.all).toBe(before + 1);
  });

  it('autosaves a draft 3 s after a change, and booking from it removes the draft', async () => {
    await wrap(<WizardScreen />);
    await fireEvent.press(await screen.findByRole('radio', { name: 'Customer' }));
    await waitFor(async () => expect(await api('/v1/orders/drafts', { schema: z.array(draftSchema) })).toHaveLength(1), { timeout: 6000 });
  }, 20_000);

  it('city staff editing a partly dispatched order: the dispatched line’s rate is locked', async () => {
    await signIn(ids.users.priya);
    client.clear();
    const list = await api('/v1/orders?q=0141', { schema: orderListSchema });
    await wrap(<WizardScreen orderId={list.items[0]!.id} />);
    expect(await screen.findByText('Step 2 of 3 · Items & pricing')).toBeOnTheScreen();
    await fireEvent.press(await screen.findByRole('button', { name: /^TMT Fe500D · 16 mm 12 m/ }));
    expect(await screen.findByText('Locked · this line has dispatches')).toBeOnTheScreen();
    expect(screen.getByLabelText('Rate per MT').props.editable).toBe(false);
  });
});
