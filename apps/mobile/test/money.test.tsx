// F4 Task 6: broker dues, broker profile and ledger (board 06), record payment (board 33),
// reverse payment, on a world built with mock fixtures: R.K. Agarwal with two dispatched trucks.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { type LedgerEntry, NetworkError, SAMPLE_MASTERS, SAMPLE_WORLD, orderSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import Brokers from '../app/(app)/brokers';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { MoreScreen } from '../src/screens/MoreScreen';
import { ledgerCaption, ledgerTitle } from '../src/screens/money/captions';
import { PartyDetailScreen } from '../src/screens/parties/PartyDetailScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { lightTokens } from '../src/theme/tokens';
import { CalendarSheet, ToastHost } from '../src/ui';
import { monthGrid } from '../src/ui/CalendarSheet';

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
const NOW = Date.UTC(2026, 10, 14, 5, 0); // 10:30 in India, 14 Nov
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

/** Two single-line orders for R.K. Agarwal, each with one dispatched truck (24,180 kg at ₹150 + ₹300, 30,120 kg at ₹150). */
async function twoOrders() {
  const make = async (l: ReturnType<typeof line>, netKg: number, vehicleNo: string) => {
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
        subOrders: [{ companyId: ids.companies.AIP, lines: [l] }],
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
      plan: [{ orderLineId: orderLine.id, plannedKg: netKg }],
      allocations: [{ orderLineId: orderLine.id, netKg }],
    });
  };
  await make(line(), 24_180, 'CG 04 MK 2291');
  await make(line({ length: { value: 6, unit: 'm' }, overpricePerMt: 0 }), 30_120, 'CG 07 AB 5567');
}

/** Rajesh's (or the signed-in person's) R.K. Agarwal profile, loaded. */
async function openProfile() {
  const view = await wrap(<PartyDetailScreen id={BROKER} />);
  expect(await screen.findByText('Due to broker')).toBeOnTheScreen();
  return view;
}

const dueCard = () => within(screen.getByTestId('due-card'));

async function openRecordPayment() {
  await press('Record payment');
  expect(await screen.findByText('Pay R.K. Agarwal')).toBeOnTheScreen();
}

async function fillPayment({ paid, tds, utr }: { paid: string; tds?: string; utr?: string }) {
  await fireEvent.changeText(screen.getByLabelText('Amount paid'), paid);
  if (tds !== undefined) await fireEvent.changeText(screen.getByLabelText('TDS deducted (optional)'), tds);
  if (utr !== undefined) await fireEvent.changeText(screen.getByLabelText('UTR / reference'), utr);
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
  resetDeviceStoresForTests();
  mock = await createMockApi({ clock: createFakeClock(NOW) });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  await signIn(ids.users.rajesh);
  await twoOrders();
});

afterEach(() => {
  client.clear();
  setTransport(null);
  setMockApi(null);
});

describe('Broker ledger: More, dues list, profile (boards 17, 06; Ruling 8)', () => {
  it('Rajesh: More shows ₹15,399 due; the dues list opens R.K. Agarwal; due, unpaid MT and the two earnings', async () => {
    let view = await wrap(<MoreScreen />);
    expect(await screen.findByText('Money & reports')).toBeOnTheScreen();
    expect(await screen.findByText('₹15,399 due')).toBeOnTheScreen();
    await press(/^Broker ledger/);
    expect(mockRouter.push).toHaveBeenCalledWith('/brokers');
    await view.unmount();

    view = await wrap(<Brokers />);
    expect(await screen.findByText('Broker ledger')).toBeOnTheScreen();
    expect(await screen.findByText('R.K. Agarwal')).toBeOnTheScreen();
    expect(screen.getByText('₹15,399 due')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('R.K. Agarwal'));
    expect(mockRouter.push).toHaveBeenCalledWith(`/parties/${BROKER}`);
    await view.unmount();

    await openProfile();
    expect(screen.getByText('Broker')).toBeOnTheScreen();
    expect(screen.getByText('Raipur · default ₹150 / MT')).toBeOnTheScreen();
    expect(dueCard().getAllByText('₹15,399')).toHaveLength(2); // the due, and earned in November
    expect(dueCard().getByText('On 54.300 MT dispatched and not yet paid')).toBeOnTheScreen();
    expect(dueCard().getByText('Earned in November')).toBeOnTheScreen();
    expect(dueCard().getByText('₹0')).toBeOnTheScreen(); // paid in November
    expect(dueCard().getByText('Paid in November')).toBeOnTheScreen();
    expect(screen.getByText('Today')).toBeOnTheScreen();
    expect(screen.getByText('+₹10,881')).toBeOnTheScreen();
    expect(screen.getByText('24.180 MT × (₹150 + ₹300 overprice)')).toBeOnTheScreen();
    expect(screen.getByText('30.120 MT × ₹150 commission')).toBeOnTheScreen();
    expect(screen.getByText('+₹4,518')).toBeOnTheScreen();
    expect(screen.getByText(/^\S+-A · CG 04 MK 2291$/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeOnTheScreen();
  });

  it('the ledger views: Payments is empty until a payment; Earnings lists the two trucks', async () => {
    await openProfile();
    await fireEvent.press(screen.getByRole('radio', { name: 'Payments' }));
    expect(await screen.findByText('No payments yet')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Earnings' }));
    expect(await screen.findByText('+₹10,881')).toBeOnTheScreen();
    expect(screen.getByText('+₹4,518')).toBeOnTheScreen();
  });
});

describe('Record payment (board 33)', () => {
  it('Full fills the due; NEFT needs a UTR; ₹10,000 + TDS ₹500 leaves ₹4,899; the due card refreshes', async () => {
    await openProfile();
    await openRecordPayment();
    expect(screen.getByText('Due now ₹15,399')).toBeOnTheScreen();
    // Empty, the amount is grey; once entered it is red (board 33).
    expect(screen.getByLabelText('Amount paid')).toHaveStyle({ color: lightTokens.tx3 });
    await press('Full ₹15,399');
    expect(screen.getByLabelText('Amount paid').props.value).toBe('15,399');
    expect(screen.getByLabelText('Amount paid')).toHaveStyle({ color: lightTokens.dgt });
    // The input is as wide as its text, so the ₹ sits against the digits.
    const measure = screen.getByTestId('amount-measure', { includeHiddenElements: true });
    expect(measure).toHaveTextContent('15,399');
    await fireEvent(measure, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 150, height: 52 } } });
    expect(screen.getByLabelText('Amount paid')).toHaveStyle({ width: 156 });
    // NEFT is the default mode and has no UTR yet.
    expect(screen.getByRole('radio', { name: 'NEFT' })).toBeChecked();
    expect(screen.getByText('UTR is needed for NEFT and UPI')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Record ₹15,399 payment' })).toBeDisabled();

    await fillPayment({ paid: '10000', tds: '500', utr: '223614' });
    expect(screen.queryByText('UTR is needed for NEFT and UPI')).toBeNull();
    expect(screen.getByLabelText('Due after this payment ₹4,899')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Record ₹10,000 payment' })).toBeEnabled();
    await press('Record ₹10,000 payment');

    expect(await screen.findByText('Payment recorded')).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByText('Pay R.K. Agarwal')).toBeNull());
    await waitFor(() => expect(dueCard().getByText('₹4,899')).toBeOnTheScreen());
    expect(await screen.findByText('UTR 223614 · TDS ₹500 · recorded by Rajesh')).toBeOnTheScreen();
    expect(screen.getByText('−₹10,500')).toBeOnTheScreen();
    expect(dueCard().getByText('₹10,500')).toBeOnTheScreen(); // paid in November
  });

  it('TDS above the amount is refused inline; Half is half the due; cheque hints "Cheque no."', async () => {
    await openProfile();
    await openRecordPayment();
    await press('Half');
    expect(screen.getByLabelText('Amount paid').props.value).toBe('7,700');
    await fillPayment({ paid: '1000', tds: '1001', utr: '223614' });
    expect(screen.getByText("TDS can't be more than the amount")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Record ₹1,000 payment' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('radio', { name: 'Cheque' }));
    expect(screen.getByRole('radio', { name: 'Cheque' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'NEFT' })).not.toBeChecked();
    expect(screen.getByLabelText('UTR / reference').props.placeholder).toBe('Cheque no.');
    await fireEvent.changeText(screen.getByLabelText('TDS deducted (optional)'), '');
    await fireEvent.changeText(screen.getByLabelText('UTR / reference'), '');
    // Cheque needs no reference.
    expect(screen.getByRole('button', { name: 'Record ₹1,000 payment' })).toBeEnabled();
  });

  it('the date defaults to today and the calendar refuses days after today', async () => {
    await openProfile();
    await openRecordPayment();
    await press('Date, 14 Nov 2026');
    expect(await screen.findByText('November 2026')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '15 Nov 2026' })).toBeDisabled();
    await press('12 Nov 2026');
    expect(await screen.findByRole('button', { name: 'Date, 12 Nov 2026' })).toBeOnTheScreen();
  });

  it('Review Focus 1: the answer is lost after the server committed; Record again reuses the key and pays once', async () => {
    await openProfile();
    await openRecordPayment();
    await fillPayment({ paid: '10000', tds: '500', utr: '223614' });
    // The first payment POST reaches the server and commits, then its answer is lost on the way back.
    const keys: string[] = [];
    let lose = true;
    setTransport({
      async request(req) {
        const res = await mock.transport.request(req);
        if (req.method === 'POST' && req.path === `/v1/brokers/${BROKER}/payments`) {
          keys.push(req.headers?.['idempotency-key'] ?? '');
          if (lose) {
            lose = false;
            throw new NetworkError('answer lost');
          }
        }
        return res;
      },
    });
    await press('Record ₹10,000 payment');
    expect(await screen.findByText("Can't reach the server. Check your connection and try again.")).toBeOnTheScreen();
    expect(screen.getByText('Pay R.K. Agarwal')).toBeOnTheScreen();
    await press('Record ₹10,000 payment');
    expect(await screen.findByText('Payment recorded')).toBeOnTheScreen();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe('');
    expect(keys[1]).toBe(keys[0]);
    await waitFor(() => expect(dueCard().getByText('₹4,899')).toBeOnTheScreen());
    const ledger = await api<{ items: LedgerEntry[] }>(`/v1/brokers/${BROKER}/ledger?view=payments`);
    expect(ledger.items.filter((i) => i.kind === 'payment')).toHaveLength(1);
  });

  it('overpaying ₹20,000 leaves an advance of ₹4,601', async () => {
    await openProfile();
    await openRecordPayment();
    await fillPayment({ paid: '20000', utr: '223614' });
    expect(screen.getByLabelText('Advance after this payment ₹4,601')).toBeOnTheScreen();
    await press('Record ₹20,000 payment');
    expect(await screen.findByText('Payment recorded')).toBeOnTheScreen();
    await waitFor(() => expect(dueCard().getByText('Advance')).toBeOnTheScreen());
    expect(dueCard().getByText('₹4,601')).toBeOnTheScreen();
    expect(dueCard().getByText('Paid ahead of earnings')).toBeOnTheScreen();
  });
});

describe('Reverse payment (Ruling 6)', () => {
  it('Wrong UTR: the due is back and the payment row says Reversed', async () => {
    await api(`/v1/brokers/${BROKER}/payments`, {
      method: 'POST',
      idempotent: true,
      body: { paidRupees: 10_000, tdsRupees: 500, mode: 'neft', utr: '223614', paidOn: '2026-11-14' },
    });
    await openProfile();
    expect(dueCard().getByText('₹4,899')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Payment · NEFT'));
    expect(await screen.findByText('UTR 223614')).toBeOnTheScreen();
    await press('Reverse payment');
    const reverse = screen.getByRole('button', { name: 'Reverse ₹10,500' });
    expect(reverse).toBeDisabled(); // reason of at least 3 characters
    await fireEvent.changeText(screen.getByLabelText('Reason'), 'Wrong UTR');
    await press('Reverse ₹10,500');
    expect(await screen.findByText('Payment reversed')).toBeOnTheScreen();
    await waitFor(() => expect(dueCard().getAllByText('₹15,399')).toHaveLength(2));
    expect(await screen.findByText('Reversed')).toBeOnTheScreen();
    expect(screen.getByText('Payment reversed · NEFT')).toBeOnTheScreen();
    expect(screen.getByText('Wrong UTR')).toBeOnTheScreen();
  });
});

describe('Ledger paging', () => {
  it('loads the next 50 rows (before the last one) when the list nears its end', async () => {
    for (let i = 0; i < 53; i += 1) {
      await api(`/v1/brokers/${BROKER}/payments`, {
        method: 'POST',
        idempotent: true,
        body: { paidRupees: 1, tdsRupees: 0, mode: 'cash', utr: null, paidOn: '2026-11-14' },
      });
    }
    await openProfile();
    const key = ['broker', BROKER, 'ledger', 'all'];
    const pages = () => client.getQueryData<{ pages: { items: LedgerEntry[] }[] }>(key)?.pages ?? [];
    expect(pages()).toHaveLength(1);
    expect(pages()[0]!.items).toHaveLength(50);
    await fireEvent(screen.getByTestId('ledger-list'), 'onEndReached');
    await waitFor(() => expect(pages()).toHaveLength(2));
    expect(pages()[1]!.items).toHaveLength(5); // 53 payments + 2 earnings
    const ids = pages().flatMap((p) => p.items.map((e) => e.id));
    expect(new Set(ids).size).toBe(55);
  });
});

describe('Unit basis', () => {
  it('kg basis: "24,180 kg × (₹0.150 + ₹0.300 overprice)" and "default ₹0.150 / kg"', async () => {
    await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
    await openProfile();
    expect(await screen.findByText('24,180 kg × (₹0.150 + ₹0.300 overprice)')).toBeOnTheScreen();
    expect(screen.getByText('On 54,300 kg dispatched and not yet paid')).toBeOnTheScreen();
    expect(screen.getByText('Raipur · default ₹0.150 / kg')).toBeOnTheScreen();
  });
});

describe('Review Focus 2: who sees money', () => {
  it('Kiran (plant head): no Money & reports on More, and /brokers redirects', async () => {
    await signIn(ids.users.kiran);
    let view = await wrap(<MoreScreen />);
    await screen.findByText('Settings');
    expect(screen.queryByText('Money & reports')).toBeNull();
    expect(screen.queryByText(/Broker ledger/)).toBeNull();
    await view.unmount();
    view = await wrap(<Brokers />);
    await waitFor(() => expect(mockRedirect).toHaveBeenCalled());
    expect(screen.queryByText('Broker ledger')).toBeNull();
    await view.unmount();
  });

  it('Priya (city staff) records a payment', async () => {
    await signIn(ids.users.priya);
    await openProfile();
    await openRecordPayment();
    await fillPayment({ paid: '10000', tds: '500', utr: '223614' });
    await press('Record ₹10,000 payment');
    expect(await screen.findByText('Payment recorded')).toBeOnTheScreen();
    await waitFor(() => expect(dueCard().getByText('₹4,899')).toBeOnTheScreen());
    expect(await screen.findByText('UTR 223614 · TDS ₹500 · recorded by Priya')).toBeOnTheScreen();
  });
});

describe('ledgerCaption / ledgerTitle', () => {
  const base: LedgerEntry = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'earning',
    amountRupees: 10_881,
    entryDate: '2026-11-14',
    createdAt: '2026-11-14T05:00:00.000Z',
    createdBy: { id: '00000000-0000-4000-8000-000000000009', name: 'Rajesh Agrawal' },
    truck: {
      truckId: '00000000-0000-4000-8000-000000000002',
      vehicleNo: 'CG 04 MK 2291',
      orderId: '00000000-0000-4000-8000-000000000003',
      orderNumber: 'AIP-2611-0142',
      subOrderNumber: 'SO-2611-0142',
      netKg: 24_180,
    },
    earningLines: [{ productName: 'TMT', netKg: 24_180, commissionPerMt: 150, overpricePerMt: 300 }],
    payment: null,
    reversesId: null,
    reversedById: null,
    note: null,
  };
  const payment: LedgerEntry = {
    ...base,
    kind: 'payment',
    amountRupees: -40_000,
    truck: null,
    earningLines: [],
    payment: { mode: 'neft', utr: '223614', paidRupees: 40_000, tdsRupees: 0, paidOn: '2026-11-13' },
  };

  it('earning captions and titles', () => {
    expect(ledgerTitle(base)).toBe('SO-2611-0142 · CG 04 MK 2291');
    expect(ledgerCaption(base, 'mt')).toBe('24.180 MT × (₹150 + ₹300 overprice)');
    expect(ledgerCaption(base, 'kg')).toBe('24,180 kg × (₹0.150 + ₹0.300 overprice)');
    const plain = { ...base, earningLines: [{ productName: 'TMT', netKg: 30_120, commissionPerMt: 150, overpricePerMt: 0 }], truck: { ...base.truck!, netKg: 30_120 } };
    expect(ledgerCaption(plain, 'mt')).toBe('30.120 MT × ₹150 commission');
    const two = {
      ...base,
      truck: { ...base.truck!, netKg: 54_300 },
      earningLines: [
        { productName: 'A', netKg: 24_180, commissionPerMt: 150, overpricePerMt: 300 },
        { productName: 'B', netKg: 30_120, commissionPerMt: 150, overpricePerMt: 0 },
      ],
    };
    expect(ledgerCaption(two, 'mt')).toBe('54.300 MT · 2 rates');
    // Two lines at the same rates are one rate.
    const same = { ...two, earningLines: two.earningLines.map((l) => ({ ...l, overpricePerMt: 300 })) };
    expect(ledgerCaption(same, 'mt')).toBe('54.300 MT × (₹150 + ₹300 overprice)');
  });

  it('payment and reversal captions and titles', () => {
    expect(ledgerTitle(payment)).toBe('Payment · NEFT');
    expect(ledgerCaption(payment, 'mt')).toBe('UTR 223614 · recorded by Rajesh');
    const tds = { ...payment, payment: { ...payment.payment!, tdsRupees: 500 } };
    expect(ledgerCaption(tds, 'mt')).toBe('UTR 223614 · TDS ₹500 · recorded by Rajesh');
    const reversal: LedgerEntry = { ...payment, kind: 'reversal', amountRupees: 40_000, payment: null, reversesId: payment.id, note: 'Wrong UTR' };
    expect(ledgerTitle(reversal, payment)).toBe('Payment reversed · NEFT');
    expect(ledgerCaption(reversal, 'mt')).toBe('Wrong UTR');
    const corrected: LedgerEntry = { ...base, kind: 'reversal', amountRupees: -10_881, reversesId: base.id };
    expect(ledgerTitle(corrected)).toBe('Weight corrected · SO-2611-0142 · CG 04 MK 2291');
    expect(ledgerCaption(corrected, 'mt')).toBe('Weight corrected');
  });
});

describe('CalendarSheet (Ruling 10)', () => {
  it('monthGrid: November 2026 starts on a Sunday and has 30 days', () => {
    const grid = monthGrid(2026, 11);
    expect(grid[0]).toBe('2026-11-01');
    expect(grid.filter(Boolean)).toHaveLength(30);
    expect(monthGrid(2026, 12).indexOf('2026-12-01')).toBe(2); // Tuesday
  });

  it('picks a day, and moves between months; later months are closed after max', async () => {
    const onPick = jest.fn();
    await wrap(<CalendarSheet value="2026-11-14" max="2026-11-14" onPick={onPick} onClose={() => undefined} />);
    expect(screen.getByText('November 2026')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
    await press('Previous month');
    expect(screen.getByText('October 2026')).toBeOnTheScreen();
    await press('31 Oct 2026');
    expect(onPick).toHaveBeenCalledWith('2026-10-31');
  });
});
