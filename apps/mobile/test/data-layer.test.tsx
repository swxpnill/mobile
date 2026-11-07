// F2.8: unit filter, order/master hooks, quantity and money components.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, toDisplayQty } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { useHome } from '../src/api/hooks/orders';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests, unitFilterStore, useUnitFilter } from '../src/prefs/unitFilter';
import { UnitSwitcherSheet } from '../src/screens/UnitSwitcherSheet';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { MoneyText, ProgressBar, QtyText } from '../src/ui';

const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
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

describe('QtyText and MoneyText', () => {
  it('the same kg reads 24.180 MT for an MT user and 24,180 kg for a kg user', async () => {
    const view = await wrap(<QtyText kg={24_180} withUnit />);
    expect(await screen.findByText('24.180 MT')).toBeOnTheScreen();
    await view.unmount();
    await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
    client.clear();
    await wrap(<QtyText kg={24_180} withUnit />);
    expect(await screen.findByText('24,180 kg')).toBeOnTheScreen();
  });

  it('MoneyText renders nothing for a redacted (missing) amount, so screens need no role checks', async () => {
    await wrap(
      <>
        <Text>before</Text>
        <MoneyText rupees={undefined} />
        <MoneyText rupees={3_864_200} short />
      </>,
    );
    expect(screen.getByText('₹38.64 L')).toBeOnTheScreen();
    expect(screen.queryByText(/₹0/)).toBeNull();
  });

  it('ProgressBar clamps to 0–100 % and says how far it is for screen readers', async () => {
    await wrap(<ProgressBar value={1.4} label="Dispatched" />);
    expect(screen.getByLabelText('Dispatched, 100 %')).toBeOnTheScreen();
  });
});

function HomePending() {
  const { companyId } = useUnitFilter();
  const home = useHome();
  return (
    <Text testID="pending">{home.data ? `${companyId}:${toDisplayQty(home.data.pendingKg, 'mt')}` : 'loading'}</Text>
  );
}

describe('unit switcher', () => {
  it('lists All units and each company with its pending; picking KRM refilters Home', async () => {
    const onClose = jest.fn();
    await wrap(
      <>
        <HomePending />
        <UnitSwitcherSheet visible onClose={onClose} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(/^all:/));
    const allText = screen.getByTestId('pending').props.children as string;
    expect(await screen.findByRole('radio', { name: /^All units. 4 companies/ })).toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: /^Kalinga Rolling Mills/ }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(`${ids.companies.KRM}:77.600`));
    expect(allText).not.toContain('77.600');
  });

  it('the choice is remembered per person: Priya starts on All units, Rajesh gets KRM back', async () => {
    const view = await wrap(<HomePending />);
    await act(async () => unitFilterStore.getState().set(ids.users.rajesh, ids.companies.KRM));
    await view.unmount();

    await signIn(ids.users.priya);
    client.clear();
    const v2 = await wrap(<HomePending />);
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(/^all:/));
    await v2.unmount();

    await signIn(ids.users.rajesh);
    client.clear();
    await wrap(<HomePending />);
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(new RegExp(`^${ids.companies.KRM}:`)));
  });

  it('a remembered company the person can no longer see falls back to All units', async () => {
    await signIn(ids.users.kiran); // plant head, AIP only
    client.clear();
    await act(async () => unitFilterStore.getState().set(ids.users.kiran, ids.companies.KRM));
    await wrap(<HomePending />);
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(/^all:/));
  });

  it('the choice survives a restart (AsyncStorage)', async () => {
    await act(async () => unitFilterStore.getState().set(ids.users.rajesh, ids.companies.NAP));
    await waitFor(async () => expect(await AsyncStorage.getItem('tonnage.unitFilter')).toContain(ids.companies.NAP));
    resetUnitFilterForTests();
    await act(async () => unitFilterStore.getState().hydrate());
    expect(unitFilterStore.getState().byUser[ids.users.rajesh]).toBe(ids.companies.NAP);
  });
});
