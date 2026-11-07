// F2.10: products list and form.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_MASTERS, SAMPLE_WORLD, productSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { z } from 'zod';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { ProductFormScreen } from '../src/screens/products/ProductFormScreen';
import { ProductsScreen } from '../src/screens/products/ProductsScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useNavigation: () => mockNavigation }));

const { ids } = SAMPLE_WORLD;
const PR = SAMPLE_MASTERS.ids.products;
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

const products = () => api('/v1/products', { schema: z.array(productSchema) });

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetUnitFilterForTests();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await signIn(ids.users.rajesh);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('ProductsScreen', () => {
  it('one list for every company: category chips with counts, conversion per MT, lengths', async () => {
    await wrap(<ProductsScreen />);
    expect(await screen.findByText('One list for every company · 10 products')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'All, 10' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'TMT, 6' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'TMT Fe500D · 12 mm, lengths 6 m, 12 m, conversion +₹1,500 per MT' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^MS Ingot · 4 inch, no standard length/ })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Angle, 1' }));
    expect(screen.queryByText('TMT Fe500D · 12 mm')).toBeNull();
    expect(screen.getByText('Angle · 50 × 50 × 5')).toBeOnTheScreen();
  });

  it('search narrows the list by name', async () => {
    await wrap(<ProductsScreen />);
    await screen.findByText('TMT Fe500D · 12 mm');
    await fireEvent.changeText(screen.getByLabelText('Search products'), 'billet');
    await waitFor(() => expect(screen.queryByText('TMT Fe500D · 12 mm')).toBeNull());
    expect(screen.getByText('MS Billet · 100 × 100')).toBeOnTheScreen();
  });
});

describe('ProductFormScreen', () => {
  it('adds Angle 65 × 65 × 6 for VSL only, with a 6 m standard length', async () => {
    await wrap(<ProductFormScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Angle' }));
    await fireEvent.changeText(screen.getByLabelText('Size'), '65 × 65 × 6');
    expect(screen.getByText('Angle · 65 × 65 × 6')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Conversion'), '2800');
    await fireEvent.changeText(screen.getByLabelText('New length'), '6');
    await fireEvent.press(screen.getByRole('button', { name: 'Add length' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: /^Vrinda Steels LLP/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const created = (await products()).find((p) => p.displayName === 'Angle · 65 × 65 × 6');
    expect(created).toMatchObject({ conversionPerMt: 2_800, standardLengths: [{ value: 6, unit: 'm' }], companyIds: [ids.companies.VSL] });
  });

  it('no company chosen → the reason shows and nothing is sent', async () => {
    await wrap(<ProductFormScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Angle' }));
    await fireEvent.changeText(screen.getByLabelText('Size'), '40 × 40 × 4');
    await fireEvent.press(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('Choose at least one company')).toBeOnTheScreen();
    expect((await products()).length).toBe(10);
  });

  it('a kg user types conversion per kg: 2.8 is saved as ₹2,800 per MT', async () => {
    await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
    client.clear();
    await wrap(<ProductFormScreen id={PR.angle} />);
    const conv = await screen.findByLabelText('Conversion');
    expect(conv.props.value).toBe('2.800');
    await fireEvent.changeText(conv, '3.1');
    await fireEvent.press(screen.getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect((await products()).find((p) => p.id === PR.angle)?.conversionPerMt).toBe(3_100);
  });

  it('deleting a product used on orders offers Make inactive instead', async () => {
    await wrap(<ProductFormScreen id={PR.tmt12} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete forever' }));
    expect(await screen.findByText(/^TMT Fe500D · 12 mm is on orders, so it can’t be deleted./)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Make inactive' }));
    await waitFor(async () => expect((await products()).find((p) => p.id === PR.tmt12)?.active).toBe(false));
  });

  it('an unused product is deleted after confirming', async () => {
    await wrap(<ProductFormScreen id={PR.channel} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect((await products()).some((p) => p.id === PR.channel)).toBe(false);
  });
});
