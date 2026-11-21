// F3 Task 10: Needs attention (restore, dismiss) and the owner's weight correction, on the demo
// seed with a rejected sync built through the mock API.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NetworkError, SAMPLE_WORLD, type SyncEvent, dispatchBoardSchema, syncResponseSchema, truckSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import More from '../app/(app)/(tabs)/more';
import Attention from '../app/(app)/attention';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { syncNow, useSync } from '../src/offline/useSync';
import { resetUnitFilterForTests } from '../src/prefs/unitFilter';
import { MoreScreen } from '../src/screens/MoreScreen';
import { NeedsAttentionScreen } from '../src/screens/attention/NeedsAttentionScreen';
import { rejectionReason } from '../src/screens/attention/describe';
import { MSG } from '../src/screens/messages';
import { TruckDetailScreen } from '../src/screens/dispatch/TruckDetailScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
const mockRedirect = jest.fn();
/** The latest focus callback the screen registered (expo-router's useFocusEffect). */
const mockFocus: { current: (() => void) | null } = { current: null };
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => {
    mockFocus.current = cb;
  },
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
  Redirect: ({ href }: { href: string }) => {
    mockRedirect(href);
    return null;
  },
}));

const { ids } = SAMPLE_WORLD;
const NOW = Date.UTC(2026, 10, 14, 5, 0); // 10:30 in India
const RAVI_PHONE = randomUUID();
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

async function boardTruck(vehicleNo: string) {
  const board = await api('/v1/dispatch', { schema: dispatchBoardSchema });
  const truck = board.items.find((t) => t.vehicleNo === vehicleNo);
  if (!truck) throw new Error(`no ${vehicleNo}`);
  return api(`/v1/trucks/${truck.id}`, { schema: truckSchema });
}

/** Ravi's phone (Siltara) pushes its outbox. */
async function raviSyncs(truckId: string, events: Omit<SyncEvent, 'eventId' | 'truckId' | 'deviceSeq' | 'capturedAtDevice'>[]) {
  const tokens = await mock.controls.signInAs(ids.users.ravi, RAVI_PHONE);
  const res = await mock.transport.request({
    method: 'POST',
    path: '/v1/weighments/sync',
    headers: { authorization: `Bearer ${tokens.accessToken}`, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    body: {
      deviceId: RAVI_PHONE,
      events: events.map((e, i) => ({ ...e, eventId: randomUUID(), truckId, deviceSeq: i, capturedAtDevice: new Date(NOW).toISOString() })),
    },
  });
  return syncResponseSchema.parse(res.body).results;
}

/** CG 10 GH 4471 cancelled while Ravi weighed it offline: his tare and gross both come back refused. */
async function rejectedSync() {
  const gh = await boardTruck('CG 10 GH 4471');
  await api(`/v1/trucks/${gh.id}/cancel`, {
    method: 'POST',
    idempotent: true,
    body: { reason: 'Vehicle did not arrive', note: '', version: gh.version },
  });
  const line = gh.plan[0]!.orderLineId;
  const results = await raviSyncs(gh.id, [
    { type: 'TARE', tareKg: 12_460 } as never,
    { type: 'GROSS', grossKg: 22_460, allocations: [{ orderLineId: line, netKg: 10_000 }] } as never,
  ]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  return gh;
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
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  await signIn(ids.users.rajesh);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('Needs attention (Ruling 8)', () => {
  it('Rajesh sees the open count on More; the row opens Needs attention', async () => {
    await rejectedSync();
    await wrap(<MoreScreen />);
    const row = await screen.findByRole('button', { name: 'Needs attention · 2 open' });
    await fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith('/attention');
  });

  it('lists both refusals in plain words; Restore puts the truck back and its weights await approval', async () => {
    const gh = await rejectedSync();
    let view = await wrap(<NeedsAttentionScreen />);
    expect(await screen.findByText('Truck was cancelled before this weight reached the server')).toBeOnTheScreen();
    expect(screen.getAllByText(/Ravi Verma · Siltara/)).toHaveLength(2);
    expect(screen.getByText('Gross 22.460 MT · net 10.000 MT')).toBeOnTheScreen();
    expect(screen.getByText('Tare 12.460 MT')).toBeOnTheScreen();

    await press(/^CG 10 GH 4471, tare/);
    expect(await screen.findByText('Puts CG 10 GH 4471 back to loading and sends these weights for approval.')).toBeOnTheScreen();
    expect(screen.getByText(/2 weights from Ravi's phone go back together/)).toBeOnTheScreen();
    await press('Restore');
    expect(await screen.findByText('Nothing needs attention')).toBeOnTheScreen();
    await view.unmount();

    view = await wrap(<TruckDetailScreen id={gh.id} />);
    await screen.findByRole('header', { name: 'CG 10 GH 4471' });
    expect(screen.getAllByText('Awaiting approval').length).toBeGreaterThan(0);
    await view.unmount();
  });

  it('a restore that puts back a vehicle already on another open truck says so in the toast', async () => {
    const gh = await rejectedSync();
    // A replacement truck with the same vehicle, on another sub-order (nothing over-planned).
    const board = await api('/v1/dispatch', { schema: dispatchBoardSchema });
    const elsewhere = board.items.find((t) => t.subOrderId !== gh.subOrderId && t.state !== 'dispatched');
    if (!elsewhere) throw new Error('no other open truck');
    const other = await api(`/v1/trucks/${elsewhere.id}`, { schema: truckSchema });
    await api(`/v1/sub-orders/${other.subOrderId}/trucks`, {
      method: 'POST',
      idempotent: true,
      body: {
        vehicleNo: gh.vehicleNo,
        transporterId: null,
        driverName: 'Ramesh',
        driverPhone: '98261 00099',
        lrNo: null,
        plan: [{ orderLineId: other.plan[0]!.orderLineId, plannedKg: 1_000 }],
      },
    });
    await wrap(<NeedsAttentionScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^CG 10 GH 4471, tare/ }));
    await screen.findByText(/^Puts CG 10 GH 4471 back/);
    await press('Restore');
    expect(await screen.findByText('Restored · CG 10 GH 4471 is also on another open truck')).toBeOnTheScreen();
  });

  it('a restore refused again says why in plain words and keeps the rejection open', async () => {
    await rejectedSync();
    await wrap(<NeedsAttentionScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^CG 10 GH 4471, tare/ }));
    await screen.findByText(/^Puts CG 10 GH 4471 back/);
    mock.controls.failNext(409, 'ORDER_LOCKED', { writesOnly: true });
    await press('Restore');
    expect(await screen.findByText('This order is closed. Reopen it first, then restore.')).toBeOnTheScreen();
    const left = await api('/v1/weighment-rejections/count');
    expect(left).toEqual({ open: 2 });
  });

  it('Dismiss needs a reason of 3 characters; then only the other refusal is left', async () => {
    await rejectedSync();
    await wrap(<NeedsAttentionScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^CG 10 GH 4471, gross/ }));
    await screen.findByText(/^Puts CG 10 GH 4471 back/);
    expect(screen.getByText(/^An earlier weight of this truck is also waiting/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Reason to dismiss'), ' ok ');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Reason to dismiss'), 'Truck went back empty');
    await press('Dismiss');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^CG 10 GH 4471, gross/ })).toBeNull());
    expect(screen.getByRole('button', { name: /^CG 10 GH 4471, tare/ })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('radio', { name: 'All' }));
    expect(await screen.findByText('Dismissed by Rajesh · Truck went back empty')).toBeOnTheScreen();
  });

  it('Priya (city staff): no More row, and /attention sends her to her first tab', async () => {
    await signIn(ids.users.priya);
    let view = await wrap(<MoreScreen />);
    await screen.findByText('Settings');
    expect(screen.queryByRole('button', { name: /^Needs attention/ })).toBeNull();
    await view.unmount();

    view = await wrap(<Attention />);
    await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith('/home'));
    expect(screen.queryByText('Needs attention')).toBeNull();
    await view.unmount();
  });
});

describe('The Needs attention badge stays live', () => {
  const badge = (n: number) => screen.findByRole('button', { name: `Needs attention · ${n} open` });

  it('a refusal made elsewhere shows after the More tab gains focus', async () => {
    await wrap(<More />);
    await badge(0);
    await rejectedSync(); // Ravi's phone, not this one
    await act(async () => mockFocus.current?.());
    expect(await badge(2)).toBeOnTheScreen();
  });

  it('… and after the app comes back to the foreground', async () => {
    await wrap(<More />);
    await badge(0);
    await rejectedSync();
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(await badge(2)).toBeOnTheScreen();
    focusManager.setFocused(undefined);
  });

  it('loading the list updates the count', async () => {
    const view = await wrap(<MoreScreen />);
    await badge(0);
    await rejectedSync();
    await view.rerender(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <UnitBasisProvider>
              <MoreScreen />
              <NeedsAttentionScreen />
            </UnitBasisProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
    expect(await badge(2)).toBeOnTheScreen();
  });

  it('a sync run on this phone refreshes the count', async () => {
    function SyncHost() {
      useSync();
      return null;
    }
    await wrap(
      <>
        <SyncHost />
        <MoreScreen />
      </>,
    );
    await badge(0);
    await rejectedSync();
    await act(() => syncNow());
    expect(await badge(2)).toBeOnTheScreen();
  });

  it('a code the screen does not know is shown in plain words, never raw', () => {
    expect(rejectionReason('FORBIDDEN')).toBe(MSG.generic);
    expect(rejectionReason('TRUCK_CANCELLED')).toBe('Truck was cancelled before this weight reached the server');
  });
});

describe('Correct weight (owner)', () => {
  async function dispatchedMk() {
    const mk = await boardTruck('CG 04 MK 2291');
    const line = mk.plan[0]!.orderLineId;
    const r = await raviSyncs(mk.id, [{ type: 'GROSS', grossKg: 36_640, allocations: [{ orderLineId: line, netKg: 24_180 }] } as never]);
    expect(r[0]?.status).toBe('accepted');
    // TON-57: the weights await the office; approving dispatches the truck.
    const weighed = await api(`/v1/trucks/${mk.id}`, { schema: truckSchema });
    return api(`/v1/trucks/${mk.id}/approve`, { method: 'POST', body: { version: weighed.version }, idempotencyKey: `approve-${mk.id}`, schema: truckSchema });
  }

  async function typeGross(keys: string) {
    await fireEvent.press(screen.getByRole('radio', { name: /^Gross/ }));
    await fireEvent(screen.getByRole('button', { name: 'Delete' }), 'longPress');
    for (const k of keys) await press(k === '.' ? 'Decimal point' : k);
  }

  it('24.180 → 22.000: shows net −2.180, saves, and the truck shows the new net', async () => {
    const mk = await dispatchedMk();
    await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    await press('Correct weight');
    expect(await screen.findByRole('header', { name: 'Correct weight · CG 04 MK 2291' })).toBeOnTheScreen();
    expect(screen.getByText('Broker earning is recalculated with the rates at dispatch')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Tare, 12.460 tonnes' })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Gross, 36.640 tonnes' })).toBeOnTheScreen();

    await typeGross('34.46');
    expect(screen.getByText('24.180 → 22.000 MT')).toBeOnTheScreen();
    expect(screen.getByText('−2.180 MT')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled(); // no reason yet
    await fireEvent.changeText(screen.getByLabelText('Reason for the correction'), 'Weighbridge recalibrated');
    await press('Save correction');

    expect(await screen.findByText(/^Broker earning ₹/)).toBeOnTheScreen();
    await press('Done');
    const after = await api(`/v1/trucks/${mk.id}`, { schema: truckSchema });
    expect(after).toMatchObject({ netKg: 22_000, grossKg: 34_460, tareKg: 12_460 });
    await waitFor(() => expect(screen.getAllByText('22.000').length).toBeGreaterThan(0));
  });

  it('STALE keeps what was typed; the next save carries the latest version', async () => {
    const mk = await dispatchedMk();
    await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    await press('Correct weight');
    await screen.findByRole('header', { name: 'Correct weight · CG 04 MK 2291' });
    await typeGross('34.46');
    await fireEvent.changeText(screen.getByLabelText('Reason for the correction'), 'Weighbridge recalibrated');

    // Someone else adds the LR meanwhile.
    await act(() => api(`/v1/trucks/${mk.id}`, { method: 'PATCH', idempotent: true, body: { lrNo: 'SGR/2611/0600', version: mk.version } }));
    await press('Save correction');
    expect(await screen.findByText('Someone else changed this truck. Check the weights and save again.')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Gross, 34.46 tonnes' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason for the correction').props.value).toBe('Weighbridge recalibrated');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save correction' })).toBeEnabled());
    await press('Save correction');
    expect(await screen.findByText(/^Broker earning ₹/)).toBeOnTheScreen();
    const after = await api(`/v1/trucks/${mk.id}`, { schema: truckSchema });
    expect(after).toMatchObject({ netKg: 22_000, lrNo: 'SGR/2611/0600' });
  });
  it('the answer to a correction is lost: the retry is replayed, so it says saved, not changed by someone else', async () => {
    const mk = await dispatchedMk();
    let lost = false;
    const keys: (string | undefined)[] = [];
    setTransport({
      async request(req) {
        const res = await mock.transport.request(req);
        if (req.path.endsWith('/correct-weight')) {
          keys.push(req.headers['idempotency-key']);
          if (!lost) {
            lost = true;
            throw new NetworkError('answer lost');
          }
        }
        return res;
      },
    });
    await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    await press('Correct weight');
    await screen.findByRole('header', { name: 'Correct weight · CG 04 MK 2291' });
    await typeGross('34.46');
    await fireEvent.changeText(screen.getByLabelText('Reason for the correction'), 'Weighbridge recalibrated');
    await press('Save correction');
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await press('Save correction');
    expect(await screen.findByText('Weight corrected')).toBeOnTheScreen();
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const after = await api(`/v1/trucks/${mk.id}`, { schema: truckSchema });
    expect(after).toMatchObject({ netKg: 22_000, version: mk.version + 1 });
  });
});
