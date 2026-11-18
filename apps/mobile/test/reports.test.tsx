// F4 Task 8: the Reports screen (board 23) on a world built with mock fixtures: R.K. Agarwal's
// orders with three dispatched trucks (two AIP, one KRM) and one ₹10,000 + ₹500 TDS payment.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { type Report, SAMPLE_MASTERS, SAMPLE_WORLD, orderSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import Reports from '../app/(app)/reports';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { tabsForRole } from '../src/nav/tabs';
import { resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { MoreScreen } from '../src/screens/MoreScreen';
import { presetRange, rangeLabel, rangeProblem } from '../src/screens/reports/ranges';
import { percentTenths, reportView, signedQty } from '../src/screens/reports/reportView';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: () => undefined,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
  Redirect: ({ href }: { href: string }) => {
    mockRedirect(href);
    return null;
  },
}));

const { ids } = SAMPLE_WORLD;
const P = SAMPLE_MASTERS.ids.parties;
const PR = SAMPLE_MASTERS.ids.products;
const A = SAMPLE_MASTERS.ids.addresses;
const BROKER = P.rkAgarwal;
const NOW = Date.UTC(2026, 10, 17, 8, 30); // 14:00 in India, 17 Nov 2026
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

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));

const line = (o: Record<string, unknown> = {}) => ({
  productId: PR.tmt12,
  length: { value: 12, unit: 'm' },
  orderedKg: 24_000,
  typedRate: null,
  overpricePerMt: 300,
  ...o,
});

/** A one-line R.K. Agarwal order on `companyId` with one dispatched truck. */
async function dispatched(companyId: string, l: ReturnType<typeof line>, plannedKg: number, netKg: number, vehicleNo: string) {
  const order = await api('/v1/orders', {
    method: 'POST',
    idempotent: true,
    schema: orderSchema,
    body: {
      draftId: null,
      type: 'customer_broker',
      customerId: P.shubham,
      brokerId: BROKER,
      commissionPerMt: 150,
      billToId: A.shubhamBill,
      shipToId: A.shubhamHingna,
      pricingMethod: 'basic_conversion',
      basicRate: 44_500,
      subOrders: [{ companyId, lines: [l] }],
      notify: { customer: true, broker: true },
    },
  });
  const sub = order.subOrders[0]!;
  const orderLine = sub.lines[0]!;
  await mock.fixtures.addTruck({
    subOrderId: sub.id,
    state: 'dispatched',
    vehicleNo,
    tareKg: 12_000,
    plan: [{ orderLineId: orderLine.id, plannedKg }],
    allocations: [{ orderLineId: orderLine.id, netKg }],
  });
}

/**
 * AIP 24,180 (plan 24,000, ₹150 + ₹300) and 30,120 (plan 30,000, ₹150); KRM 20,500 (plan 20,000,
 * ₹150). Net 74,800 kg, 3 trucks, +800 kg over plan. Earned ₹10,881 + ₹4,518 + ₹3,075 = ₹18,474;
 * paid ₹10,000 + ₹500 TDS; due ₹7,974.
 */
async function world() {
  await dispatched(ids.companies.AIP, line(), 24_000, 24_180, 'CG 04 MK 2291');
  await dispatched(ids.companies.AIP, line({ length: { value: 6, unit: 'm' }, orderedKg: 30_000, overpricePerMt: 0 }), 30_000, 30_120, 'CG 07 AB 5567');
  await dispatched(
    ids.companies.KRM,
    line({ productId: PR.tmt16, length: { value: 40, unit: 'ft' }, orderedKg: 30_000, typedRate: 45_600, overpricePerMt: 0 }),
    20_000,
    20_500,
    'CG 04 KK 0003',
  );
  await api(`/v1/brokers/${BROKER}/payments`, {
    method: 'POST',
    idempotencyKey: 'reports-test-payment',
    body: { paidRupees: 10_000, tdsRupees: 500, mode: 'neft', utr: '223614', paidOn: '2026-11-17' },
  });
}

async function openReports() {
  const view = await wrap(<Reports />);
  expect(await screen.findByText('Reports')).toBeOnTheScreen();
  return view;
}

const preview = () => within(screen.getByTestId('report-preview'));

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
  resetDeviceStoresForTests();
  mock = await createMockApi({ clock: createFakeClock(NOW) });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  await signIn(ids.users.rajesh);
  await world();
});

afterEach(() => {
  client.clear();
  setTransport(null);
  setMockApi(null);
});

describe('Reports (board 23)', () => {
  it('Rajesh: More → Reports; month to date, Dispatch register selected with its three stats; KRM leaves one row', async () => {
    let view = await wrap(<MoreScreen />);
    await screen.findByRole('button', { name: 'Reports' });
    await press('Reports');
    expect(mockRouter.push).toHaveBeenCalledWith('/reports');
    await view.unmount();

    view = await openReports();
    expect(screen.getByRole('button', { name: 'Date range, 1 – 17 Nov 2026' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Dispatch register/ })).toBeSelected();
    expect(screen.getByRole('button', { name: /^Pending orders/ })).not.toBeSelected();
    expect(screen.getByRole('button', { name: /^Over \/ under loading/ })).toBeOnTheScreen();

    expect(await preview().findAllByText('74.800')).toHaveLength(2); // the stat and the total
    // The three stats (label, value, caption), each read as one item.
    expect(preview().getByLabelText('Dispatched 74.800 MT')).toBeOnTheScreen();
    expect(preview().getByLabelText('Trucks 3 this period')).toBeOnTheScreen();
    expect(preview().getByLabelText('Over / under +0.800 MT net')).toBeOnTheScreen();
    expect(preview().getByText('+0.800')).toBeOnTheScreen();
    expect(preview().getByText('MT net')).toBeOnTheScreen();
    expect(preview().getByText('Net MT')).toBeOnTheScreen();
    expect(screen.getByText('1 – 17 Nov')).toBeOnTheScreen(); // the card's range caption
    expect(preview().getByText('Aarav · AIP')).toBeOnTheScreen();
    expect(preview().getByText('Kalinga · KRM')).toBeOnTheScreen();
    expect(preview().getByText('54.300')).toBeOnTheScreen();
    expect(preview().getByText('Total')).toBeOnTheScreen();

    await press('Unit, All units');
    await fireEvent.press(await screen.findByRole('radio', { name: /^Kalinga Rolling Mills/ }));
    await waitFor(() => expect(preview().queryByText('Aarav · AIP')).toBeNull());
    expect(preview().getByText('Kalinga · KRM')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Unit, Kalinga · KRM' })).toBeOnTheScreen();
    expect(preview().getAllByText('20.500').length).toBeGreaterThan(0);
    await view.unmount();
  });

  it('Broker-wise shows earned, paid and due per broker', async () => {
    await openReports();
    await press(/^Broker-wise/);
    expect(screen.getByRole('button', { name: /^Broker-wise/ })).toBeSelected();
    expect(await preview().findByText('R.K. Agarwal')).toBeOnTheScreen();
    expect(preview().getByText('Earned ₹18,474 · Paid ₹10,500')).toBeOnTheScreen();
    expect(preview().getByText('₹7,974 due')).toBeOnTheScreen();
    expect(preview().getByText('Earned')).toBeOnTheScreen();
    expect(preview().getByText('Paid')).toBeOnTheScreen();
    expect(preview().getByText('Due')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Filter, All brokers' })).toBeOnTheScreen();
  });

  it('Excel and PDF are disabled ("Coming soon") until the export kit lands', async () => {
    await openReports();
    await preview().findAllByText('74.800');
    for (const name of ['Excel', 'PDF']) {
      const b = screen.getByRole('button', { name });
      expect(b).toBeDisabled();
      expect(b.props.accessibilityHint).toBe('Coming soon');
    }
    expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
  });

  it('Share opens the share sheet with a one-line summary in the viewer basis (Ruling 12)', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    await openReports();
    await preview().findAllByText('74.800');
    await press('Share');
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Dispatch register · 1 – 17 Nov 2026 · 74.800 MT · 3 trucks' }),
    );
    share.mockRestore();
  });

  it('a Custom range with the end before the start is refused', async () => {
    await openReports();
    await press('Date range, 1 – 17 Nov 2026');
    await fireEvent.press(await screen.findByRole('radio', { name: /^Custom/ }));
    await press('From, 1 Nov 2026');
    await press('17 Nov 2026');
    await press('To, 17 Nov 2026');
    await press('10 Nov 2026');
    expect(await screen.findByText('Pick an end date on or after the start')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('Review Focus 5: a range with no trucks shows the empty text and disables every export', async () => {
    await openReports();
    await preview().findAllByText('74.800');
    await press('Date range, 1 – 17 Nov 2026');
    await fireEvent.press(await screen.findByRole('radio', { name: /^Last month/ }));
    expect(await screen.findByRole('button', { name: 'Date range, 1 – 31 Oct 2026' })).toBeOnTheScreen();
    expect(await preview().findByText('No trucks dispatched in this period')).toBeOnTheScreen();
    for (const name of ['Excel', 'PDF', 'Share']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('Pending orders hides the range and reads "As of now"', async () => {
    await openReports();
    await press(/^Pending orders/);
    expect(await screen.findAllByText('As of now')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Date range/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter, All ages' })).toBeOnTheScreen();
  });

  it('the age filter chip keeps the picked label while its options load again', async () => {
    await openReports();
    await press(/^Pending orders/);
    await press('Filter, All ages');
    await fireEvent.press(await screen.findByRole('radio', { name: '0–5 days' }));
    expect(await screen.findByRole('button', { name: 'Filter, 0–5 days' })).toBeOnTheScreen();
    await press(/^Dispatch register/);
    // Pending orders loads afresh and its request hangs, so the bucket options are not there yet.
    client.removeQueries({ queryKey: ['report', 'pending-orders'] });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    setTransport({
      async request(req) {
        if (req.path.startsWith('/v1/reports/pending-orders')) await held;
        return mock.transport.request(req);
      },
    });
    await press(/^Pending orders/);
    expect(screen.getByLabelText('Loading Pending orders')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Filter, 0–5 days' })).toBeOnTheScreen();
    release();
    expect(await screen.findByRole('button', { name: 'Filter, 0–5 days' })).toBeOnTheScreen();
  });

  it('switching kind keeps the card at its last loaded height while the next report loads (stable scroll)', async () => {
    await openReports();
    await preview().findAllByText('74.800');
    await fireEvent(screen.getByTestId('report-preview'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 350, height: 412 } } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    setTransport({
      async request(req) {
        if (req.path.startsWith('/v1/reports/product-wise')) await held;
        return mock.transport.request(req);
      },
    });
    await press(/^Product-wise/);
    expect(screen.getByLabelText('Loading Product-wise')).toBeOnTheScreen();
    expect(screen.getByTestId('report-preview')).toHaveStyle({ minHeight: 412 });
    release();
    expect(await preview().findByText('Items')).toBeOnTheScreen();
  });

  it('kg basis: the table header reads "Net kg"', async () => {
    await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
    await openReports();
    expect(await preview().findByText('Net kg')).toBeOnTheScreen();
    expect(preview().getAllByText('74,800').length).toBeGreaterThan(0);
  });
});

describe('Review Focus 2: who sees reports', () => {
  it('Priya (city staff) sees Reports', async () => {
    await signIn(ids.users.priya);
    const view = await wrap(<MoreScreen />);
    await screen.findByRole('button', { name: 'Reports' });
    await press('Reports');
    expect(mockRouter.push).toHaveBeenCalledWith('/reports');
    await view.unmount();
    await openReports();
    expect(await preview().findAllByText('74.800')).toHaveLength(2); // the stat and the total
  });

  it('Kiran (plant head): no Reports row, and /reports redirects', async () => {
    await signIn(ids.users.kiran);
    let view = await wrap(<MoreScreen />);
    await screen.findByText('Settings');
    expect(screen.queryByText('Reports')).toBeNull();
    await view.unmount();
    view = await wrap(<Reports />);
    await waitFor(() => expect(mockRedirect).toHaveBeenCalled());
    expect(screen.queryByText('Dispatch register')).toBeNull();
    await view.unmount();
  });

  it("Ravi (supervisor): tabs unchanged, and /reports redirects", async () => {
    expect(tabsForRole('supervisor')).toEqual(['tasks', 'done', 'profile']);
    await signIn(ids.users.ravi);
    await wrap(<Reports />);
    await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/tasks'));
  });
});

describe('ranges', () => {
  it('presets and labels', () => {
    const today = '2026-11-17';
    expect(presetRange('today', today)).toEqual({ from: today, to: today });
    expect(presetRange('yesterday', today)).toEqual({ from: '2026-11-16', to: '2026-11-16' });
    expect(presetRange('thisMonth', today)).toEqual({ from: '2026-11-01', to: today });
    expect(presetRange('lastMonth', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('lastMonth', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('thisFy', today)).toEqual({ from: '2026-04-01', to: today });
    expect(presetRange('thisFy', '2027-02-03')).toEqual({ from: '2026-04-01', to: '2027-02-03' });
    expect(rangeLabel('2026-11-01', '2026-11-17')).toBe('1 – 17 Nov 2026');
    expect(rangeLabel('2026-11-17', '2026-11-17')).toBe('17 Nov 2026');
    expect(rangeLabel('2026-10-28', '2026-11-17')).toBe('28 Oct – 17 Nov 2026');
    expect(rangeLabel('2025-12-01', '2026-01-17')).toBe('1 Dec 2025 – 17 Jan 2026');
    expect(rangeLabel('2026-11-01', '2026-11-17', { year: false })).toBe('1 – 17 Nov');
    expect(rangeProblem({ from: '2026-11-17', to: '2026-11-10' }, '2026-11-17')).toBe('Pick an end date on or after the start');
    expect(rangeProblem({ from: '2025-11-01', to: '2026-11-17' }, '2026-11-17')).toBe('Pick at most 366 days');
    expect(rangeProblem({ from: '2026-11-01', to: '2026-11-18' }, '2026-11-17')).toBe("The end date can't be after today");
    expect(rangeProblem({ from: '2026-11-01', to: '2026-11-17' }, '2026-11-17')).toBeNull();
  });

  it('signed quantities and variance percent', () => {
    expect(signedQty(800, 'mt')).toBe('+0.800');
    expect(signedQty(-120, 'mt')).toBe('−0.120');
    expect(signedQty(0, 'kg')).toBe('0');
    expect(signedQty(-1_420, 'kg')).toBe('−1,420');
    expect(percentTenths(8)).toBe('+0.8 %');
    expect(percentTenths(-18)).toBe('−1.8 %');
    expect(percentTenths(0)).toBe('0.0 %');
    expect(percentTenths(null)).toBe('');
  });
});

describe('reportView', () => {
  const base = { from: '2026-11-01', to: '2026-11-17', truncated: false } as const;

  it('a zero over / under reads unsigned "0.000", never "+0.000" or "−0.000"', () => {
    const variance = (overKg: number, underKg: number): Report => ({
      ...base,
      kind: 'loading-variance',
      rows: [],
      summary: { trucks: 2, overTrucks: overKg ? 1 : 0, underTrucks: underKg ? 1 : 0, overKg, underKg },
    });
    const zero = reportView(variance(0, 0), 'mt').stats;
    expect(zero[1].caption).toBe('0.000 MT');
    expect(zero[2].caption).toBe('0.000 MT');
    const some = reportView(variance(180, 420), 'mt').stats;
    expect(some[1].caption).toBe('+0.180 MT');
    expect(some[2].caption).toBe('−0.420 MT');
    const register: Report = {
      ...base,
      kind: 'dispatch-register',
      rows: [],
      summary: { netKg: 0, trucks: 0, overUnderKg: 0, valueRupees: 0, byCompany: [] },
    };
    expect(reportView(register, 'mt').stats[2].value).toBe('0.000');
    expect(signedQty(-0, 'mt')).toBe('0.000');
  });

  it('pending orders: "Oldest" is the largest age, whatever the row order', () => {
    const row = (id: string, ageDays: number) => ({
      subOrderId: id,
      orderId: id,
      subOrderNumber: `SO-${ageDays}`,
      companyCode: 'AIP',
      customerName: null,
      createdAt: '2026-11-01T00:00:00Z',
      ageDays,
      bucket: '0–5',
      orderedKg: 1_000,
      dispatchedKg: 0,
      pendingKg: 1_000,
    });
    const pending: Report = {
      ...base,
      kind: 'pending-orders',
      rows: [row('00000000-0000-4000-8000-000000000001', 3), row('00000000-0000-4000-8000-000000000002', 14)],
      summary: { pendingKg: 2_000, subOrders: 2, byBucket: [] },
    };
    expect(reportView(pending, 'mt').stats[2]).toMatchObject({ label: 'Oldest', value: '14' });
  });
});
