import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { auditA11y } from './a11y/audit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, dispatchBoardSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { openDeviceStore, resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { eventId } from '../src/offline/deviceStoreContract';
import { recordCapture, syncNow, useSync, useSyncStatus } from '../src/offline/useSync';
import { DemoToolsScreen } from '../src/screens/DemoToolsScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { WeighTruckScreen } from '../src/screens/supervisor/CaptureScreen';
import { DispatchedScreen } from '../src/screens/supervisor/DispatchedScreen';
import { DoneTodayScreen } from '../src/screens/supervisor/DoneTodayScreen';
import { SyncBanner } from '../src/screens/supervisor/SyncBanner';
import { TasksScreen } from '../src/screens/supervisor/TasksScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
const mockNavigation = { getState: () => undefined, dispatch: jest.fn() };
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    useNavigation: () => mockNavigation,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

const { ids } = SAMPLE_WORLD;
const NOW = Date.UTC(2026, 10, 14, 5, 0); // 10:30 in India

let mock: MockApi;
let client: QueryClient;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}

/** The signed-in layout's sync loop, as `app/(app)/_layout.tsx` mounts it. */
function SyncHost() {
  useSync();
  return null;
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
          <UnitBasisProvider>
            <SyncHost />
            {ui}
            <ToastHost />
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));
const typeWeight = async (keys: string) => {
  for (const k of keys) await press(k === '.' ? 'Decimal point' : k);
};
const ravisStore = () => openDeviceStore(ids.users.ravi);

/** The truck id of a vehicle on the owner's dispatch board, with its plan lines. */
async function boardTruck(vehicleNo: string) {
  const board = await api('/v1/dispatch', { schema: dispatchBoardSchema });
  const truck = board.items.find((t) => t.vehicleNo === vehicleNo);
  if (!truck) throw new Error(`no ${vehicleNo}`);
  return truck;
}

/** Opens a task from My tasks the way the supervisor does; returns its truck id. */
async function openTask(action: 'Capture gross weight' | 'Capture tare weight', vehicleNo: string) {
  const view = await wrap(<TasksScreen />);
  const card = await screen.findByLabelText(new RegExp(`^${vehicleNo}`));
  await fireEvent.press(within(card).getByRole('button', { name: action }));
  const href = mockRouter.push.mock.calls.at(-1)?.[0] as string;
  await view.unmount();
  return href.replace('/weigh/', '');
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetDeviceStoresForTests();
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  await signIn(ids.users.ravi);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('My tasks', () => {
  it('shows the plant, the counts and Siltara’s trucks with their state and next action', async () => {
    const view = await wrap(<TasksScreen />);

    const card = await screen.findByLabelText(/^CG 04 MK 2291/);
    expect(within(card).getByText('Tare 12.460 t')).toBeOnTheScreen();
    expect(within(card).getByText('Load TMT Fe500D · 12 mm · 12 m')).toBeOnTheScreen();
    expect(within(card).getByText('24.000 MT')).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: 'Capture gross weight' })).toBeOnTheScreen();
    const kl = screen.getByLabelText(/^CG 07 KL 3304/);
    expect(within(kl).getByText('Arrived')).toBeOnTheScreen();
    expect(within(kl).getByRole('button', { name: 'Capture tare weight' })).toBeEnabled();
    // TON-57: an assigned truck is marked arrived first; its tare waits.
    const gh = screen.getByLabelText(/^CG 10 GH 4471/);
    expect(within(gh).getByRole('button', { name: 'Vehicle arrived' })).toBeEnabled();
    expect(within(gh).getByRole('button', { name: 'Capture tare weight' })).toBeDisabled();
    expect(within(gh).getByText('Mark the vehicle arrived first')).toBeOnTheScreen();
    expect(screen.queryByText(/at gate/i)).toBeNull();
    expect(await screen.findByText('Aarav Ispat Pvt Ltd · Siltara')).toBeOnTheScreen();
    expect(screen.getByLabelText('Need tare, 2')).toBeOnTheScreen();
    expect(screen.getByLabelText('Need gross, 1')).toBeOnTheScreen();
    expect(screen.queryByText('No network')).toBeNull(); // all synced: no banner
    await view.unmount();
  });

  it('Vehicle arrived saves one arrival on this phone; the card reads Arrived, the button goes and tare opens', async () => {
    const view = await wrap(<TasksScreen />);
    const card = await screen.findByLabelText(/^CG 10 GH 4471/);
    await fireEvent.press(within(card).getByRole('button', { name: 'Vehicle arrived' }));
    expect(await screen.findByText('Saved on this phone')).toBeOnTheScreen();
    const rows = await (await ravisStore()).outbox();
    expect(rows.map((r) => r.type)).toEqual(['AT_GATE']);
    await waitFor(() => {
      const now = screen.getByLabelText(/^CG 10 GH 4471/);
      expect(within(now).getByText('Arrived')).toBeOnTheScreen();
      expect(within(now).getByRole('button', { name: 'Capture tare weight' })).toBeEnabled();
      expect(within(now).queryByRole('button', { name: 'Vehicle arrived' })).toBeNull();
    });
    await view.unmount();
  });

  it('offline: arrival then tare queue in order and are both accepted on sync', async () => {
    let view = await wrap(<TasksScreen />);
    const card = await screen.findByLabelText(/^CG 10 GH 4471/); // tasks pulled while online
    mock.controls.setOffline(true);
    await fireEvent.press(within(card).getByRole('button', { name: 'Vehicle arrived' }));
    await waitFor(() => expect(within(screen.getByLabelText(/^CG 10 GH 4471/)).getByRole('button', { name: 'Capture tare weight' })).toBeEnabled());
    await view.unmount();

    const truckId = await openTask('Capture tare weight', 'CG 10 GH 4471');
    view = await wrap(<WeighTruckScreen truckId={truckId} />);
    await screen.findByText('Tare weight');
    await typeWeight('11.5');
    await press('Save tare · start loading');
    expect(await screen.findAllByText('Saved on this phone')).not.toHaveLength(0);
    const store = await ravisStore();
    expect((await store.outbox()).map((r) => r.type)).toEqual(['AT_GATE', 'TARE']);

    mock.controls.setOffline(false);
    await act(() => syncNow());
    expect((await store.outbox()).map((r) => r.status)).toEqual(['accepted', 'accepted']);
    await view.unmount();
  });

  it('a tare link on a truck not marked arrived asks for the arrival first, then shows the keypad', async () => {
    // The truck as it reached this phone (a supervisor has no Dispatch board).
    const tasks = await wrap(<TasksScreen />);
    await screen.findByLabelText(/^CG 10 GH 4471/);
    await tasks.unmount();
    const gh = (await (await ravisStore()).getTasks()).find((x) => x.vehicleNo === 'CG 10 GH 4471')!;
    const view = await wrap(<WeighTruckScreen truckId={gh.truckId} />);
    expect(await screen.findByText('Mark the vehicle arrived first')).toBeOnTheScreen();
    expect(screen.queryByTestId('weight-readout')).toBeNull();
    await press('Vehicle arrived');
    expect(await screen.findByTestId('weight-readout')).toBeOnTheScreen();
    expect(screen.getByLabelText('Progress: step 3 of 5, Tare')).toBeOnTheScreen();
    expect((await (await ravisStore()).outbox()).map((r) => r.type)).toEqual(['AT_GATE']);
    await view.unmount();
  });
});

describe('Capture', () => {
  it('tare: violet screen, saves a TARE row, then back to My tasks', async () => {
    const truckId = await openTask('Capture tare weight', 'CG 07 KL 3304');
    const view = await wrap(<WeighTruckScreen truckId={truckId} />);
    await screen.findByText('Tare weight');
    expect(screen.getByText('After tare, load')).toBeOnTheScreen();
    await typeWeight('11.98');
    expect(screen.getByTestId('weight-readout')).toHaveTextContent(/^11\.98/);
    await press('Save tare · start loading');
    expect(await screen.findByText('Saved on this phone')).toBeOnTheScreen();
    const rows = await (await ravisStore()).outbox();
    expect(rows.map((r) => [r.type, r.payload.tareKg])).toEqual([['TARE', 11_980]]);
    expect(mockRouter.back).toHaveBeenCalled();
    await view.unmount();
  });

  it('gross 36.640 over tare 12.460: net 24.180, +0.180 over; offline save, banner, then the slip once synced', async () => {
    const truckId = await openTask('Capture gross weight', 'CG 04 MK 2291');
    let view = await wrap(<WeighTruckScreen truckId={truckId} />);
    await screen.findByText('Gross weight');
    expect(screen.getByText('Planned 24.000 MT')).toBeOnTheScreen();
    // The seeded tare was weighed 25 min before 10:30 IST.
    expect(screen.getByText('Tare · weighed 10:05')).toBeOnTheScreen();
    expect(screen.getByText('− 12.460')).toBeOnTheScreen();

    await typeWeight('36.640');
    expect(screen.getByText('24.180 MT')).toBeOnTheScreen();
    expect(screen.getByText('+0.180 over · allowed')).toBeOnTheScreen();

    mock.controls.setOffline(true); // Demo tools → Offline
    await press('Save gross · send for approval');
    expect(await screen.findByText('Saved on this phone')).toBeOnTheScreen();
    const rows = await (await ravisStore()).outbox();
    expect(rows.map((r) => r.type)).toEqual(['GROSS']);
    expect(rows[0]?.payload).toEqual({
      grossKg: 36_640,
      allocations: [{ orderLineId: expect.any(String), netKg: 24_180 }],
    });
    expect(mockRouter.replace).toHaveBeenCalledWith(`/dispatched/${truckId}`);
    await view.unmount();

    // The banner on My tasks; the dispatched truck is off the list.
    view = await wrap(<TasksScreen />);
    expect(await screen.findByText('No network')).toBeOnTheScreen();
    expect(
      screen.getByText('1 weight saved on this phone · they sync automatically'),
    ).toBeOnTheScreen();
    await screen.findByLabelText(/^CG 07 KL 3304/);
    expect(screen.queryByLabelText(/^CG 04 MK 2291/)).toBeNull();
    await view.unmount();

    view = await wrap(<DispatchedScreen truckId={truckId} />);
    expect(await screen.findByRole('header', { name: 'Weights saved' })).toBeOnTheScreen();
    expect(screen.getByText('24.180')).toBeOnTheScreen();
    expect(await screen.findByText('Waiting for network')).toBeOnTheScreen();

    mock.controls.setOffline(false);
    await act(() => syncNow());
    // TON-57: synced, the weights wait for the office; no slip until it approves.
    expect(await screen.findByText('Awaiting approval')).toBeOnTheScreen();
    expect(screen.queryByText('Waiting for network')).toBeNull();
    expect(screen.queryByText(/^LS-AIP-/)).toBeNull();
    expect(useSyncStatus.getState()).toMatchObject({ pending: 0, online: true });
    await view.unmount();

    view = await wrap(<DoneTodayScreen />);
    const done = await screen.findByLabelText(/^CG 04 MK 2291/);
    expect(within(done).getByText('24.180')).toBeOnTheScreen();
    await view.unmount();
  });

  it('the tare time stays the weighing time after the truck is edited', async () => {
    await signIn(ids.users.rajesh);
    const mk = await boardTruck('CG 04 MK 2291');
    await api(`/v1/trucks/${mk.id}`, {
      method: 'PATCH',
      idempotent: true,
      body: { driverName: 'Suresh Yadav', version: mk.version },
    });
    await signIn(ids.users.ravi);

    const view = await wrap(<WeighTruckScreen truckId={mk.id} />);
    await screen.findByText('Gross weight');
    expect(screen.getByText('Tare · weighed 10:05')).toBeOnTheScreen(); // not the edit at 10:30
    await view.unmount();
  });

  it('an implausible net (10 t of a 24 t plan) asks before saving', async () => {
    const truckId = await openTask('Capture gross weight', 'CG 04 MK 2291');
    const view = await wrap(<WeighTruckScreen truckId={truckId} />);
    await screen.findByText('Gross weight');
    await typeWeight('22.460');
    expect(screen.getByText('10.000 MT')).toBeOnTheScreen();
    expect(screen.getByText('−14.000 under · allowed')).toBeOnTheScreen();
    await press('Save gross · send for approval');
    expect(await screen.findByText('Net is 42 % of the plan. Save anyway?')).toBeOnTheScreen();
    expect(await (await ravisStore()).outbox()).toEqual([]);
    await press('Save anyway');
    expect(await screen.findByText('Saved on this phone')).toBeOnTheScreen();
    expect((await (await ravisStore()).outbox()).map((r) => r.payload.grossKg)).toEqual([22_460]);
    await view.unmount();
  });

  it('net at or below zero cannot be saved', async () => {
    const truckId = await openTask('Capture gross weight', 'CG 04 MK 2291');
    const view = await wrap(<WeighTruckScreen truckId={truckId} />);
    await screen.findByText('Gross weight');
    await typeWeight('12.4');
    expect(screen.getByText('Gross must be more than the tare')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Save gross · send for approval' })).toBeDisabled();
    await view.unmount();
  });

  it('two plan lines: split step prefilled pro rata; Save only while the split sums to net', async () => {
    await signIn(ids.users.rajesh);
    const mk = await boardTruck('CG 04 MK 2291');
    const kl = await boardTruck('CG 07 KL 3304');
    const a = mk.plan[0]!.orderLineId;
    const b = kl.plan[0]!.orderLineId;
    const { truckId } = await mock.fixtures.addTruck({
      subOrderId: mk.subOrderId,
      state: 'loading',
      vehicleNo: 'CG 04 TT 1001',
      tareKg: 12_000,
      plan: [
        { orderLineId: a, plannedKg: 10_000 },
        { orderLineId: b, plannedKg: 10_000 },
      ],
    });
    await signIn(ids.users.ravi);

    const view = await wrap(<WeighTruckScreen truckId={truckId} />);
    await screen.findByText('Gross weight');
    await typeWeight('32.001');
    await press('Save gross · send for approval');

    const first = await screen.findByLabelText('TMT Fe500D · 12 mm · 12 m');
    const second = screen.getByLabelText('TMT Fe500D · 12 mm · 6 m');
    expect(first.props.value).toBe('10.001'); // largest remainder goes to the first line
    expect(second.props.value).toBe('10.000');
    const save = () => screen.getByRole('button', { name: 'Save gross · send for approval' });
    expect(save()).toBeEnabled();

    await fireEvent.changeText(first, '9.000');
    expect(screen.getByText('Left to allocate')).toBeOnTheScreen();
    expect(screen.getByText('1.001 MT')).toBeOnTheScreen();
    expect(save()).toBeDisabled();

    await fireEvent.changeText(first, '10.001');
    expect(save()).toBeEnabled();
    await fireEvent.press(save());
    expect(await screen.findByText('Saved on this phone')).toBeOnTheScreen();
    const [row] = await (await ravisStore()).outbox();
    expect(row?.payload.allocations).toEqual([
      { orderLineId: a, netKg: 10_001 },
      { orderLineId: b, netKg: 10_000 },
    ]);
    await view.unmount();
  });
});

describe('Accessibility audit (F5 Task 10)', () => {
  it('My tasks, and capture tare and gross with the keypad: named, roled, 44 dp, a header', async () => {
    const tasks = await wrap(<TasksScreen />);
    await screen.findByLabelText(/^CG 07 KL 3304/);
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
    await tasks.unmount();
    for (const [action, vehicle] of [['Capture tare weight', 'CG 07 KL 3304'], ['Capture gross weight', 'CG 04 MK 2291']] as const) {
      const truckId = await openTask(action, vehicle);
      const view = await wrap(<WeighTruckScreen truckId={truckId} />);
      await screen.findByTestId('weight-readout');
      expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
      await view.unmount();
    }
  });
});

describe('Sign-out guard (Ruling 11)', () => {
  async function pendingWeight() {
    const view = await wrap(<TasksScreen />);
    const card = await screen.findByLabelText(/^CG 10 GH 4471/);
    mock.controls.setOffline(true);
    await fireEvent.press(within(card).getByRole('button', { name: 'Vehicle arrived' }));
    await waitFor(() => expect(useSyncStatus.getState().online).toBe(false));
    return view;
  }

  it('sign out with an unsent weight opens the guard; typing SIGN OUT signs out anyway', async () => {
    const view = await pendingWeight();
    await view.unmount();
    await wrap(<ProfileScreen />);
    const row = await screen.findByRole('button', { name: 'Sign out, 1 weight not sent yet' });
    await fireEvent.press(row);
    expect(await screen.findByRole('header', { name: '1 weight not sent yet' })).toBeOnTheScreen();
    expect(useSession.getState().status).toBe('signedIn');
    expect(screen.getByRole('button', { name: 'Send now' })).toBeOnTheScreen();

    await press('Sign out anyway');
    const confirm = () => screen.getAllByRole('button', { name: 'Sign out anyway' }).at(-1)!;
    expect(confirm()).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Type SIGN OUT to confirm'), 'SIGN OUT');
    await fireEvent.press(confirm());
    await waitFor(() => expect(useSession.getState().status).toBe('signedOut'));
    // The event stays in Ravi's store on this phone.
    expect((await (await ravisStore()).outbox()).map((r) => r.status)).toEqual(['pending']);
  });

  it('switching person in Demo tools with an unsent weight shows the same guard', async () => {
    const view = await pendingWeight();
    await view.unmount();
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Rajesh Agrawal/ }));
    expect(await screen.findByRole('header', { name: '1 weight not sent yet' })).toBeOnTheScreen();
    expect(useSession.getState().status).toBe('signedIn');
    expect(mock.controls.getState().offline).toBe(true); // nothing switched yet
  });
});

describe('Weights held behind a refusal', () => {
  const OWNER_DEVICE = '019a4c00-00ff-7000-8000-0000000000aa';

  async function asOwner(method: 'GET' | 'POST', path: string, body?: unknown) {
    const { accessToken } = await mock.controls.signInAs(ids.users.rajesh, OWNER_DEVICE);
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (method === 'POST') {
      headers['idempotency-key'] = eventId();
      headers['content-type'] = 'application/json';
    }
    const res = await mock.transport.request({ method, path, headers, body });
    if (res.status >= 300) throw new Error(`${path}: ${res.status}`);
    return res.body as { id: string }[];
  }

  it('the banner shows refused and waiting weights together', async () => {
    await wrap(<TasksScreen />);
    await screen.findByLabelText(/^CG 10 GH 4471/);
    await act(async () => useSyncStatus.setState({ online: false, pending: 1, rejected: 2 }));
    expect(screen.getByText('2 weights need the owner')).toBeOnTheScreen();
    expect(screen.getByText('No network')).toBeOnTheScreen();
  });

  it('a refused gross and one held behind it reach Needs attention, count in the guard, and clear once the owner dismisses them', async () => {
    const view = await wrap(<TasksScreen />);
    await screen.findByLabelText(/^CG 04 MK 2291/);
    const store = await ravisStore();
    const truck = (await store.getTasks()).find((t) => t.vehicleNo === 'CG 04 MK 2291')!;
    const lineId = truck.plan[0]!.orderLineId;
    // 1 kg off the net: refused (ALLOC_MISMATCH); the truck stays loading on the server.
    const grossOf = (netKg: number) => ({
      eventId: eventId(),
      truckId: truck.truckId,
      type: 'GROSS' as const,
      payload: { grossKg: 12_460 + 24_180, allocations: [{ orderLineId: lineId, netKg }] },
      capturedAtDevice: new Date(NOW).toISOString(),
    });
    await act(() => recordCapture(store, grossOf(24_179)));
    await waitFor(() => expect(useSyncStatus.getState().rejected).toBe(1));
    // Weighed again after the refusal: held on the phone, then sent behind the refused one.
    const held = await act(() => recordCapture(store, grossOf(24_180)));
    expect(held.status).toBe('blocked');
    await act(() => syncNow());
    expect((await store.outbox()).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const open = await asOwner('GET', '/v1/weighment-rejections');
    expect(open.length).toBe(2);
    expect(await screen.findByText('2 weights need the owner')).toBeOnTheScreen();
    await view.unmount();

    const profile = await wrap(<ProfileScreen />);
    expect(await screen.findByRole('button', { name: 'Sign out, 2 weights not sent yet' })).toBeOnTheScreen();
    await profile.unmount();

    for (const r of open) await asOwner('POST', `/v1/weighment-rejections/${r.id}/dismiss`, { reason: 'Weighed again' });
    await wrap(<SyncBanner />);
    await act(() => syncNow());
    await waitFor(() => expect(useSyncStatus.getState().rejected).toBe(0));
    expect(screen.queryByText(/need the owner/)).toBeNull();
    expect((await store.outbox()).map((r) => r.status)).toEqual(['resolved', 'resolved']);
    const again = await act(() => recordCapture(store, grossOf(24_180)));
    expect(again.status).toBe('pending');
  });
});
