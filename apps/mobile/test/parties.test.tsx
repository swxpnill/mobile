// F2.9: customers, brokers and transporters — list, detail, form.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_MASTERS, SAMPLE_WORLD, partySchema, partySummarySchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { z } from 'zod';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { PartiesScreen } from '../src/screens/parties/PartiesScreen';
import { PartyDetailScreen } from '../src/screens/parties/PartyDetailScreen';
import { PartyFormScreen } from '../src/screens/parties/PartyFormScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn() };
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    useNavigation: () => mockNavigation,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

const { ids } = SAMPLE_WORLD;
const P = SAMPLE_MASTERS.ids.parties;
let mock: MockApi;
let client: QueryClient;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}

const wrap = (ui: ReactElement) =>
  render(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}
    >
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

const allParties = () => api('/v1/parties', { schema: z.array(partySummarySchema) });

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

describe('PartiesScreen', () => {
  it('customers first, with pending; tabs show counts; brokers and transporters one tap away', async () => {
    await wrap(<PartiesScreen initialType="customer" />);
    expect(await screen.findByText('Shared across all 4 companies')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Customers 4' })).toBeChecked();
    expect(screen.getByRole('button', { name: /^Shubham Traders, Nagpur · 2 people · 3 numbers, 84\.000 MT pending$/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Gupta Hardware.*no pending$/ })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Brokers 2' }));
    expect(await screen.findByText('Mittal Brokers')).toBeOnTheScreen();
    expect(screen.queryByText('Shubham Traders')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add broker' })).toBeOnTheScreen();
  });

  it('search by a phone number as typed finds the party across types', async () => {
    await wrap(<PartiesScreen initialType="broker" />);
    await screen.findByText('R.K. Agarwal');
    await fireEvent.changeText(screen.getByLabelText('Search parties'), '98260 12345');
    expect(await screen.findByText('Shubham Traders')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Customers 1' })).toBeChecked();
  });

  it('a search with no match says so', async () => {
    await wrap(<PartiesScreen initialType="customer" />);
    await screen.findByText('Shubham Traders');
    await fireEvent.changeText(screen.getByLabelText('Search parties'), 'zzz');
    expect(await screen.findByText('No parties match “zzz”')).toBeOnTheScreen();
  });
});

describe('PartyDetailScreen', () => {
  it('contacts with every number: call and WhatsApp buttons, addresses, open orders and pending', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await wrap(<PartyDetailScreen id={P.shubham} />);
    expect(await screen.findByText('Suresh Jain')).toBeOnTheScreen();
    expect(screen.getByText('84.000 MT')).toBeOnTheScreen();
    expect(screen.getByText('Plot 14, Wardhaman Nagar, Nagpur 440008')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Call +91 98260 12345' }));
    expect(open).toHaveBeenCalledWith('tel:+919826012345');
    await fireEvent.press(screen.getByRole('button', { name: 'WhatsApp +91 98260 12345' }));
    expect(open).toHaveBeenCalledWith('https://wa.me/919826012345');
    // An office landline gets no WhatsApp button.
    expect(screen.queryByRole('button', { name: 'WhatsApp +91 71225 51234' })).toBeNull();
    open.mockRestore();
  });

  it('a transporter shows its contacts only (trips arrive with dispatch)', async () => {
    await wrap(<PartyDetailScreen id={P.shreeGanesh} />);
    expect(await screen.findByText('Manoj Sahu')).toBeOnTheScreen();
    expect(screen.queryByText('Open orders')).toBeNull();
  });
});

describe('PartyFormScreen', () => {
  async function fillBroker() {
    await fireEvent.changeText(await screen.findByLabelText('Business name'), 'Sharma Steel Brokers');
    await fireEvent.changeText(screen.getByLabelText('City'), 'Raipur');
    await fireEvent.changeText(screen.getByLabelText('Default commission'), '150');
    await fireEvent.changeText(screen.getByLabelText('Contact name'), 'Vinod Sharma');
    await fireEvent.changeText(screen.getByLabelText('Phone number'), '98271 55012');
  }

  it('adds a broker with a commission and a WhatsApp mobile', async () => {
    await wrap(<PartyFormScreen type="broker" />);
    await fillBroker();
    await fireEvent.press(screen.getByRole('button', { name: 'Save party' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const brokers = (await allParties()).filter((p) => p.type === 'broker');
    const created = brokers.find((b) => b.name === 'Sharma Steel Brokers');
    expect(created).toMatchObject({ defaultCommissionPerMt: 150, people: 1, numbers: 1 });
    const full = await api(`/v1/parties/${created!.id}`, { schema: partySchema });
    expect(full.contacts[0]?.numbers[0]).toMatchObject({ number: '+919827155012', whatsapp: true });
  });

  it('a kg user types commission per kg: 0.15 is saved as ₹150 per MT', async () => {
    await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
    client.clear();
    await wrap(<PartyFormScreen type="broker" />);
    await fillBroker();
    await fireEvent.changeText(screen.getByLabelText('Default commission'), '0.15');
    await fireEvent.press(screen.getByRole('button', { name: 'Save party' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect((await allParties()).find((b) => b.name === 'Sharma Steel Brokers')?.defaultCommissionPerMt).toBe(150);
  });

  it('GSTIN is checked as it is typed, and one already used names the other party', async () => {
    await wrap(<PartyFormScreen type="broker" />);
    await fillBroker();
    await fireEvent.changeText(screen.getByLabelText('GSTIN'), '27aakfs1234l1z5');
    // Invented sample GSTIN: right shape and state, wrong check digit → a warning, never a block.
    expect(await screen.findByText(/Maharashtra · check digit doesn’t match/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Save party' }));
    expect(await screen.findByText('Already used by Shubham Traders')).toBeOnTheScreen();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('a customer without a ship-to site is not sent; the reason shows on the form', async () => {
    const before = (await allParties()).length;
    await wrap(<PartyFormScreen type="customer" />);
    await fireEvent.changeText(await screen.findByLabelText('Business name'), 'Om Sai Steel Agency');
    await fireEvent.changeText(screen.getByLabelText('City'), 'Bilaspur');
    await fireEvent.changeText(screen.getByLabelText('Contact name'), 'Om Prakash');
    await fireEvent.changeText(screen.getByLabelText('Phone number'), '98261 77001');
    await fireEvent.changeText(screen.getByLabelText('Bill to address'), 'Link Road, Bilaspur');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove ship-to site 1' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save party' }));
    expect(await screen.findByText('Add at least one ship-to site')).toBeOnTheScreen();
    expect((await allParties()).length).toBe(before);
  });

  it('editing keeps the type locked and saves with the version; a stale save reloads', async () => {
    await wrap(<PartyFormScreen id={P.mittal} />);
    const commission = await screen.findByLabelText('Default commission');
    expect(screen.getByText(/^Broker. A party is one type only. Its type can’t change.$/)).toBeOnTheScreen();
    // Someone else edits Mittal meanwhile.
    const current = await api(`/v1/parties/${P.mittal}`, { schema: partySchema });
    await api(`/v1/parties/${P.mittal}`, { method: 'PATCH', body: { ...current, city: 'Bhilai' } });
    await fireEvent.changeText(commission, '130');
    await fireEvent.press(screen.getByRole('button', { name: 'Save party' }));
    expect(await screen.findByText('Someone else changed this. Showing the latest.')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByLabelText('City').props.value).toBe('Bhilai'));
  });
});
