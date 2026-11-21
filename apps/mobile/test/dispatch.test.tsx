// F3 Task 9: assign / edit vehicle, Dispatch board, truck detail, in-plant trucks (canvas 07, 08,
// 09, 34, 02) on the demo seed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { Linking } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { auditA11y } from './a11y/audit';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  type Order,
  SAMPLE_WORLD,
  dispatchBoardSchema,
  orderListSchema,
  orderSchema,
  truckSchema,
} from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { NetworkError, type TransportRequest } from '@tonnage/shared';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { openDeviceStore, resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { syncNow, useDeviceStore, useSync } from '../src/offline/useSync';
import { resetUnitFilterForTests, unitFilterStore } from '../src/prefs/unitFilter';
import { AssignVehicleScreen } from '../src/screens/dispatch/AssignVehicleScreen';
import { DispatchScreen } from '../src/screens/dispatch/DispatchScreen';
import { OwnerWeighScreen } from '../src/screens/dispatch/OwnerWeighScreen';
import { TruckDetailScreen } from '../src/screens/dispatch/TruckDetailScreen';
import { truckToTask } from '../src/screens/dispatch/truckStateMeta';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { OrderDetailScreen } from '../src/screens/orders/OrderDetailScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost } from '../src/ui';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({}) }));

const { ids } = SAMPLE_WORLD;
const NOW = Date.UTC(2026, 10, 14, 5, 0); // 10:30 in India
let mock: MockApi;
let client: QueryClient;
let nowSpy: jest.SpyInstance;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}

function SyncHost() {
  useSync();
  return null;
}

const wrap = (ui: ReactElement, opts: { sync?: boolean } = {}) =>
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>
            {opts.sync === false ? null : <SyncHost />}
            {ui}
            <ToastHost />
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));
/** Write actions a plant head must never see. */
const ACTIONS = /^(Assign(?!ed)|Cancel|Edit|Capture|Correct|Approve|Change)/;
const noRupees = () => expect(screen.queryAllByText(/₹/)).toHaveLength(0);

/** The demo order whose number ends in `tail`, as the signed-in person sees it. */
async function orderEnding(tail: string): Promise<Order> {
  const list = await api(`/v1/orders?q=${tail}`, { schema: orderListSchema });
  const id = list.items.find((o) => o.number.endsWith(tail))!.id;
  return api(`/v1/orders/${id}`, { schema: orderSchema });
}

async function boardTruck(vehicleNo: string) {
  const board = await api('/v1/dispatch', { schema: dispatchBoardSchema });
  const truck = board.items.find((t) => t.vehicleNo === vehicleNo);
  if (!truck) throw new Error(`no ${vehicleNo}`);
  return truck;
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

describe('Assign vehicle (canvas 07)', () => {
  it('Rajesh assigns CG 04 MK 2291 from 0142-A: detail says Assigned, the order says 1 assigned', async () => {
    const o = await orderEnding('0142');
    const subA = o.subOrders.find((s) => s.suffix === 'A')!;
    // The seed's waiting truck on 0142-A did not come: cancelled first, so the new one is the only one assigned.
    const gh = await boardTruck('CG 10 GH 4471');
    await api(`/v1/trucks/${gh.id}/cancel`, {
      method: 'POST',
      idempotent: true,
      body: { reason: 'Vehicle did not arrive', note: '', version: gh.version },
    });

    let view = await wrap(<AssignVehicleScreen orderId={o.id} subOrderId={subA.id} />);
    expect(await screen.findByText('Loads at Aarav · Siltara.')).toBeOnTheScreen();
    expect(screen.getByText(`${subA.number} · Shubham Traders`)).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Vehicle number'), 'cg 04 mk 2291');
    expect(screen.getByLabelText('Vehicle number').props.value).toBe('CG 04 MK 2291');
    await fireEvent.changeText(screen.getByLabelText('Driver name'), 'Ramesh Yadav');
    await fireEvent.changeText(screen.getByLabelText('Driver phone'), '98271 44012');
    // Load plan: only the 16 mm line has anything left to plan (all 20 t, the cancelled truck's 10 t
    // included); it comes checked and prefilled.
    expect(screen.getByText(/^20\.000 MT pending/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Planned MT, TMT Fe500D · 16 mm · 12 m').props.value).toBe('20.000');
    await press('Assign · notify plant');

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    const href = mockRouter.replace.mock.calls.at(-1)?.[0] as string;
    expect(href).toMatch(/^\/trucks\//);
    // The same vehicle is still loading on another truck: a warning, never a block.
    expect(await screen.findByText(/CG 04 MK 2291 is on another open truck/)).toBeOnTheScreen();
    await view.unmount();

    view = await wrap(<TruckDetailScreen id={href.replace('/trucks/', '')} />);
    expect(await screen.findByRole('header', { name: 'CG 04 MK 2291' })).toBeOnTheScreen();
    expect(screen.getAllByText('Assigned').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Progress: step 1 of 5, Assigned')).toBeOnTheScreen();
    expect(screen.queryByText('Gross weighed')).toBeNull();
    await view.unmount();

    view = await wrap(<OrderDetailScreen id={o.id} />);
    expect(await screen.findByText(/1 assigned/)).toBeOnTheScreen();
    await view.unmount();
  });

  it('a Recent chip fills the vehicle, transporter and driver', async () => {
    const o = await orderEnding('0142');
    const subB = o.subOrders.find((s) => s.suffix === 'B')!;
    await wrap(<AssignVehicleScreen orderId={o.id} subOrderId={subB.id} />);
    expect(await screen.findByText('Loads at Kalinga · Borai.')).toBeOnTheScreen();
    await press('Recent vehicle CG 04 MK 2291');
    expect(screen.getByLabelText('Vehicle number').props.value).toBe('CG 04 MK 2291');
    expect(screen.getByLabelText('Driver name').props.value).toBe('Ramesh Yadav');
    expect(screen.getByLabelText('Driver phone').props.value).toBe('98271 44012');
    expect(screen.getByRole('button', { name: 'Transporter, Shree Ganesh Roadlines' })).toBeOnTheScreen();
  });

  it('a broker-only order without a customer cannot get a vehicle', async () => {
    const o = await orderEnding('0139');
    await wrap(<AssignVehicleScreen orderId={o.id} subOrderId={o.subOrders[0]!.id} />);
    expect(await screen.findByText('Add a customer to this order before assigning a vehicle')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Assign · notify plant' })).toBeDisabled();
  });

  it('edit (canvas 34): LR saved on a loading truck; the plan is hidden once the tare exists', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    await wrap(<AssignVehicleScreen orderId={mk.orderId} subOrderId={mk.subOrderId} truckId={mk.id} />);
    expect(await screen.findByText('Edit vehicle')).toBeOnTheScreen();
    expect(screen.queryByText('Load plan')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('LR number'), 'SGR/2611/0500');
    await press('Save changes');
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const after = await api(`/v1/trucks/${mk.id}`, { schema: truckSchema });
    expect(after.lrNo).toBe('SGR/2611/0500');
  });
});

describe('Cancel truck', () => {
  it('cancel with a reason: the board no longer lists it under Open', async () => {
    const gh = await boardTruck('CG 10 GH 4471');
    let view = await wrap(<TruckDetailScreen id={gh.id} />);
    await screen.findByRole('header', { name: 'CG 10 GH 4471' });
    await press('Cancel truck');
    expect(await screen.findByRole('header', { name: 'Cancel CG 10 GH 4471?' })).toBeOnTheScreen();
    await press('Vehicle did not arrive');
    await fireEvent.changeText(screen.getByLabelText('Note'), 'Driver unreachable');
    await press('Cancel this truck');
    expect(await screen.findByText('CG 10 GH 4471 cancelled')).toBeOnTheScreen();
    await view.unmount();

    view = await wrap(<DispatchScreen />);
    expect(await screen.findByLabelText(/^CG 04 MK 2291/)).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^CG 10 GH 4471/)).toBeNull();
    await view.unmount();
  });
});

describe('Dispatch board (canvas 08)', () => {
  it('owner: open trucks with counts, filters and search', async () => {
    await wrap(<DispatchScreen />);
    const mk = await screen.findByLabelText(/^CG 04 MK 2291/);
    expect(within(mk).getByText('Loading')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^CG 07 BR 8810/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open, 5' })).toBeOnTheScreen();
    await press('Arrived, 1');
    expect(screen.queryByText(/at gate/i)).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText(/^CG 04 MK 2291/)).toBeNull());
    expect(screen.getByLabelText(/^CG 07 KL 3304/)).toBeOnTheScreen();
  });

  it('Kiran (plant head): Siltara only, read-only, no money', async () => {
    await signIn(ids.users.kiran);
    let view = await wrap(<DispatchScreen />);
    await screen.findByLabelText(/^CG 04 MK 2291/);
    expect(screen.queryByLabelText(/^CG 07 BR 8810/)).toBeNull();
    expect(screen.queryAllByRole('button', { name: ACTIONS })).toHaveLength(0);
    noRupees();
    await view.unmount();

    const mk = await boardTruck('CG 04 MK 2291');
    view = await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    expect(screen.queryAllByRole('button', { name: ACTIONS })).toHaveLength(0);
    noRupees();
    await view.unmount();
  });

  it('the KRM unit filter shows only KRM trucks', async () => {
    unitFilterStore.getState().set(ids.users.rajesh, ids.companies.KRM);
    await wrap(<DispatchScreen />);
    expect(await screen.findByLabelText(/^CG 07 BR 8810/)).toBeOnTheScreen();
    // The KRM truck is also in the unfiltered list, so wait for the filtered page to replace it.
    await waitFor(() => expect(screen.queryByLabelText(/^CG 04 MK 2291/)).toBeNull());
  });
});

describe('Home: In plant now', () => {
  it('lists the loading truck', async () => {
    await wrap(<HomeScreen />);
    expect(await screen.findByRole('header', { name: 'In plant now' })).toBeOnTheScreen();
    const row = await screen.findByRole('button', { name: /^CG 04 MK 2291/ });
    expect(within(row).getByText('Loading')).toBeOnTheScreen();
  });
});

describe('Owner weighs from the truck detail (Ruling 4)', () => {
  it('tare for a truck assigned a moment ago goes through the owner’s outbox and syncs', async () => {
    const o = await orderEnding('0142');
    const subB = o.subOrders.find((s) => s.suffix === 'B')!;
    const fresh = await api(`/v1/sub-orders/${subB.id}/trucks`, {
      method: 'POST',
      idempotent: true,
      body: {
        vehicleNo: 'CG 04 ZZ 9001',
        transporterId: null,
        driverName: 'Test Driver',
        driverPhone: '9826100099',
        lrNo: null,
        plan: [{ orderLineId: subB.lines[0]!.id, plannedKg: 10_000 }],
      },
      schema: truckSchema,
    });

    let view = await wrap(<TruckDetailScreen id={fresh.id} />);
    await screen.findByRole('header', { name: 'CG 04 ZZ 9001' });
    await press('Capture tare weight');
    expect(mockRouter.push).toHaveBeenCalledWith(`/weigh/${fresh.id}`);
    await view.unmount();

    view = await wrap(<OwnerWeighScreen truckId={fresh.id} />);
    await screen.findByText('Tare weight');
    const invalidated = jest.spyOn(client, 'invalidateQueries');
    for (const k of '12.1') await press(k === '.' ? 'Decimal point' : k);
    await press('Save tare · start loading');
    expect(await screen.findByText('Saved on this phone')).toBeOnTheScreen();
    // Once sent, everything a truck change touches is asked again (afterTruckChange), the truck too.
    await waitFor(() => {
      const keys = invalidated.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
      for (const k of [['truck'], ['order', fresh.orderId], ['parties'], ['dispatch']])
        expect(keys).toContain(JSON.stringify(k));
    });
    const store = await openDeviceStore(ids.users.rajesh);
    expect((await store.outbox()).map((r) => [r.truckId, r.type])).toEqual([
      [fresh.id, 'AT_GATE'], // TON-57: the arrival goes first, then the tare
      [fresh.id, 'TARE'],
    ]);
    await act(() => syncNow());
    const after = await api(`/v1/trucks/${fresh.id}`, { schema: truckSchema });
    expect(after).toMatchObject({ state: 'loading', tareKg: 12_100 });
    await view.unmount();
  });
});

// ---- Fix round 1 ----

describe('Plant head redaction and scope (Review Focus 4)', () => {
  const MONEY = /"(earningRupees|breakdown)"/;

  it('owner control: the truck of a broker order carries earningRupees', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    expect(JSON.stringify(await api(`/v1/trucks/${mk.id}`))).toMatch(/"earningRupees"/);
    expect(JSON.stringify(await api('/v1/dispatch'))).toMatch(/"earningRupees"/);
  });

  it('Kiran: no earningRupees or breakdown in the truck or the board; a Borai truck is 404', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    const br = await boardTruck('CG 07 BR 8810'); // Borai, as the owner sees it
    await signIn(ids.users.kiran);
    expect(JSON.stringify(await api(`/v1/trucks/${mk.id}`))).not.toMatch(MONEY);
    expect(JSON.stringify(await api('/v1/dispatch'))).not.toMatch(MONEY);
    await expect(api(`/v1/trucks/${br.id}`)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    await wrap(<TruckDetailScreen id={br.id} />);
    expect(await screen.findByText('Not found')).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: 'CG 07 BR 8810' })).toBeNull();
  });
});

describe('Owner weighs the step the server is at', () => {
  it('a stale assigned copy on the phone (v1) loses to the server loading truck (v2): gross opens', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    const server = await api(`/v1/trucks/${mk.id}`, { schema: truckSchema });
    const store = await openDeviceStore(ids.users.rajesh);
    const stale = { ...truckToTask(server), state: 'assigned' as const, tareKg: null, tareAt: null, version: server.version - 1 };
    const at = new Date(NOW).toISOString();
    await store.replaceTasks({ items: [stale], removed: [], resolved: [], deleted: [], cursor: at, serverTime: at });
    useDeviceStore.setState({ store });

    await wrap(<OwnerWeighScreen truckId={mk.id} />, { sync: false });
    expect(await screen.findByRole('header', { name: 'Weigh products' })).toBeOnTheScreen();
    expect(screen.queryByText('Tare weight')).toBeNull();
    useDeviceStore.setState({ store: null });
  });

  it('TON-57: the owner gets Add product from the order (the truck has no sub-order lines)', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    useDeviceStore.setState({ store: await openDeviceStore(ids.users.rajesh) });
    await wrap(<OwnerWeighScreen truckId={mk.id} />, { sync: false });
    await screen.findByRole('header', { name: 'Weigh products' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Add product' }));
    expect(await screen.findByRole('button', { name: /^TMT Fe500D · 12 mm · 6 m, .* pending$/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^TMT Fe500D · 12 mm · 12 m,/ })).toBeNull();
    useDeviceStore.setState({ store: null });
  });

  it('a truck awaiting approval has nothing to weigh', async () => {
    const lt = await boardTruck('CG 04 LT 6619');
    useDeviceStore.setState({ store: await openDeviceStore(ids.users.rajesh) });
    await wrap(<OwnerWeighScreen truckId={lt.id} />, { sync: false });
    expect(await screen.findByText('Nothing to weigh')).toBeOnTheScreen();
    expect(screen.getByText('Its weights are saved and waiting for approval.')).toBeOnTheScreen();
    useDeviceStore.setState({ store: null });
  });
});

describe('Edit keeps what the person typed', () => {
  async function openEdit() {
    const mk = await boardTruck('CG 04 MK 2291');
    await wrap(<AssignVehicleScreen orderId={mk.orderId} subOrderId={mk.subOrderId} truckId={mk.id} />);
    await screen.findByText('Edit vehicle');
    await fireEvent.changeText(screen.getByLabelText('LR number'), 'SGR/NEW/1');
    // Someone else edits the truck meanwhile.
    await api(`/v1/trucks/${mk.id}`, { method: 'PATCH', idempotent: true, body: { driverName: 'Suresh Yadav', version: mk.version } });
    return mk;
  }

  it('a STALE save keeps the typed LR, says why, and offers the latest', async () => {
    await openEdit();
    await press('Save changes');
    expect(await screen.findByText(/Someone else changed this truck/)).toBeOnTheScreen();
    expect(screen.getByLabelText('LR number').props.value).toBe('SGR/NEW/1');
    expect(await screen.findByText('This truck changed.')).toBeOnTheScreen();
    expect(mockRouter.back).not.toHaveBeenCalled();
    await press('Reload latest');
    expect(screen.getByLabelText('Driver name').props.value).toBe('Suresh Yadav');
    expect(screen.queryByText('This truck changed.')).toBeNull();
  });

  it('a background refetch with a newer version does not clear the form', async () => {
    await openEdit();
    await act(() => client.invalidateQueries({ queryKey: ['truck'] }));
    expect(await screen.findByText('This truck changed.')).toBeOnTheScreen();
    expect(screen.getByLabelText('LR number').props.value).toBe('SGR/NEW/1');
    expect(screen.getByLabelText('Driver name').props.value).toBe('Ramesh Yadav');
  });
});

describe('Truck writes carry an Idempotency-Key, reused on retry', () => {
  /** The first matching request is lost on the way out; every key sent is recorded. */
  function loseFirst(match: (r: TransportRequest) => boolean) {
    const keys: (string | undefined)[] = [];
    let lost = false;
    setTransport({
      async request(req) {
        if (match(req)) {
          keys.push(req.headers['idempotency-key']);
          if (!lost) {
            lost = true;
            throw new NetworkError('lost');
          }
        }
        return mock.transport.request(req);
      },
    });
    return keys;
  }

  it('cancel: the retry sends the same key', async () => {
    const gh = await boardTruck('CG 10 GH 4471');
    const keys = loseFirst((r) => r.method === 'POST' && r.path.endsWith('/cancel'));
    await wrap(<TruckDetailScreen id={gh.id} />);
    await screen.findByRole('header', { name: 'CG 10 GH 4471' });
    await press('Cancel truck');
    await press('Vehicle did not arrive');
    await press('Cancel this truck');
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await press('Cancel this truck');
    expect(await screen.findByText('CG 10 GH 4471 cancelled')).toBeOnTheScreen();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
  });

  it('cancel applied but its answer lost: the retry replays it instead of coming back STALE', async () => {
    const gh = await boardTruck('CG 10 GH 4471');
    let lost = false;
    setTransport({
      async request(req) {
        const res = await mock.transport.request(req);
        if (!lost && req.method === 'POST' && req.path.endsWith('/cancel')) {
          lost = true;
          throw new NetworkError('answer lost');
        }
        return res;
      },
    });
    await wrap(<TruckDetailScreen id={gh.id} />);
    await screen.findByRole('header', { name: 'CG 10 GH 4471' });
    await press('Cancel truck');
    await press('Vehicle did not arrive');
    await press('Cancel this truck');
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await press('Cancel this truck');
    expect(await screen.findByText('CG 10 GH 4471 cancelled')).toBeOnTheScreen();
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
  });

  it('edit: the retry sends the same key', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    const keys = loseFirst((r) => r.method === 'PATCH' && r.path.startsWith('/v1/trucks/'));
    await wrap(<AssignVehicleScreen orderId={mk.orderId} subOrderId={mk.subOrderId} truckId={mk.id} />);
    await screen.findByText('Edit vehicle');
    await fireEvent.changeText(screen.getByLabelText('LR number'), 'SGR/2611/0600');
    await press('Save changes');
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await press('Save changes');
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
  });

  it('cancel: a changed reason after a lost request is a new key, so the change is not dropped', async () => {
    const gh = await boardTruck('CG 10 GH 4471');
    const keys = loseFirst((r) => r.method === 'POST' && r.path.endsWith('/cancel'));
    await wrap(<TruckDetailScreen id={gh.id} />);
    await screen.findByRole('header', { name: 'CG 10 GH 4471' });
    await press('Cancel truck');
    await press('Vehicle did not arrive');
    await press('Cancel this truck');
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Note'), 'Driver unreachable');
    await press('Cancel this truck');
    expect(await screen.findByText('CG 10 GH 4471 cancelled')).toBeOnTheScreen();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('edit: a changed LR after a lost request is a new key, and the new LR is saved', async () => {
    const mk = await boardTruck('CG 04 MK 2291');
    const keys = loseFirst((r) => r.method === 'PATCH' && r.path.startsWith('/v1/trucks/'));
    await wrap(<AssignVehicleScreen orderId={mk.orderId} subOrderId={mk.subOrderId} truckId={mk.id} />);
    await screen.findByText('Edit vehicle');
    await fireEvent.changeText(screen.getByLabelText('LR number'), 'SGR/2611/0600');
    await press('Save changes');
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('LR number'), 'SGR/2611/0601');
    await press('Save changes');
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect((await api(`/v1/trucks/${mk.id}`, { schema: truckSchema })).lrNo).toBe('SGR/2611/0601');
  });
});

describe('Approve dispatch (TON-57)', () => {
  /** A Siltara truck on 0142-A whose weights are saved: 24.180 MT net, awaiting approval. */
  async function weighedAtSiltara(): Promise<string> {
    const o = await orderEnding('0142');
    const sub = o.subOrders.find((x) => x.companyCode === 'AIP')!;
    const line = sub.lines[0]!;
    const { truckId } = await mock.controls.addTruck({
      subOrderId: sub.id,
      state: 'weighed',
      vehicleNo: 'CG 04 ZZ 0420',
      tareKg: 12_460,
      plan: [{ orderLineId: line.id, plannedKg: 24_000 }],
      allocations: [{ orderLineId: line.id, netKg: 24_180 }],
    });
    return truckId;
  }

  it('owner: To approve lists the weighed truck first; Approve from the card dispatches it with a slip', async () => {
    await wrap(<DispatchScreen />);
    expect(await screen.findByRole('button', { name: 'To approve, 1' })).toBeOnTheScreen();
    const card = await screen.findByLabelText(/^CG 04 LT 6619, Awaiting approval/);
    expect(within(card).getByText(/net 11.040 MT/)).toBeOnTheScreen();
    // Never shown as dispatched before the approval.
    expect(within(card).queryByText('Dispatched')).toBeNull();

    const id = (await boardTruck('CG 04 LT 6619')).id;
    await press('Approve dispatch, CG 04 LT 6619');
    expect(await screen.findByText('Approve CG 04 LT 6619?')).toBeOnTheScreen();
    expect(screen.getByLabelText('Net 11.040 MT')).toBeOnTheScreen();
    expect(screen.getByLabelText('Tare 11.780 MT, gross 22.820 MT')).toBeOnTheScreen();
    await press('Approve dispatch of CG 04 LT 6619');
    expect(await screen.findByText(/^CG 04 LT 6619 dispatched · LS-KRM-/)).toBeOnTheScreen();

    const after = await api(`/v1/trucks/${id}`, { schema: truckSchema });
    expect(after.state).toBe('dispatched');
    expect(after.loadingSlipNo).toMatch(/^LS-KRM-/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'To approve, 0' })).toBeOnTheScreen());
  });

  it('city staff on the detail: a note, Change weights before approving, then Approve', async () => {
    await signIn(ids.users.priya);
    const lt = await boardTruck('CG 04 LT 6619');
    await wrap(<TruckDetailScreen id={lt.id} />);
    await screen.findByRole('header', { name: 'CG 04 LT 6619' });
    expect(screen.getByText(/check the weights and approve the dispatch/)).toBeOnTheScreen();
    expect(screen.getByText('Next · the office approves the dispatch')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Capture/ })).toBeNull();

    await press('Change weights');
    expect(await screen.findByText('Change weights · CG 04 LT 6619')).toBeOnTheScreen();
    expect(screen.getByText('Nothing is dispatched until you approve')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));

    await press('Approve dispatch');
    expect(await screen.findByText('Approve CG 04 LT 6619?')).toBeOnTheScreen();
    await press('Approve dispatch of CG 04 LT 6619');
    expect(await screen.findByText(/^CG 04 LT 6619 dispatched · LS-KRM-/)).toBeOnTheScreen();
    expect(await screen.findByText('Approved · dispatched')).toBeOnTheScreen();
  });

  it('Kiran (plant head) sees a Siltara truck awaiting approval, without any action', async () => {
    const id = await weighedAtSiltara();
    await signIn(ids.users.kiran);
    await wrap(<TruckDetailScreen id={id} />);
    await screen.findByRole('header', { name: 'CG 04 ZZ 0420' });
    expect(screen.getAllByText('Awaiting approval').length).toBeGreaterThan(0);
    expect(screen.getByText(/waiting for the office to approve/)).toBeOnTheScreen();
    expect(screen.queryAllByRole('button', { name: ACTIONS })).toHaveLength(0);
    noRupees();
  });

  it('a lost approval is retried with the same key and dispatches once', async () => {
    const keys: (string | undefined)[] = [];
    let lost = false;
    setTransport({
      async request(req) {
        if (req.method === 'POST' && req.path.endsWith('/approve')) {
          keys.push(req.headers['idempotency-key']);
          if (!lost) {
            lost = true;
            throw new NetworkError('lost');
          }
        }
        return mock.transport.request(req);
      },
    });
    const lt = await boardTruck('CG 04 LT 6619');
    await wrap(<TruckDetailScreen id={lt.id} />);
    await screen.findByRole('header', { name: 'CG 04 LT 6619' });
    await press('Approve dispatch');
    const approve = () => press('Approve dispatch of CG 04 LT 6619');
    await approve();
    expect(await screen.findByText(/reach the server/)).toBeOnTheScreen();
    await approve();
    expect(await screen.findByText(/^CG 04 LT 6619 dispatched/)).toBeOnTheScreen();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('Plant supervisors on the truck (TON-57 Ruling 11)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('owner: Ravi at Siltara with Call and WhatsApp; the message names the truck and its stage', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const mk = await boardTruck('CG 04 MK 2291');
    await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    expect(screen.getByText('Supervisor at Siltara')).toBeOnTheScreen();
    expect(screen.getByLabelText('Ravi Verma, supervisor, +91 98261 00014')).toBeOnTheScreen();

    await press('WhatsApp Ravi Verma');
    expect(open).toHaveBeenLastCalledWith(
      'https://wa.me/919826100014?text=CG%2004%20MK%202291%20%C2%B7%20SO-2611-0142-A%20%C2%B7%20Loading',
    );
    await press('Call Ravi Verma');
    expect(open).toHaveBeenLastCalledWith('tel:+919826100014');
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });

  it('a plant with no active supervisor says so, with no buttons', async () => {
    await api(`/v1/users/${ids.users.ravi}/deactivate`, { method: 'POST' });
    const mk = await boardTruck('CG 04 MK 2291');
    await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    expect(screen.getByText('No supervisor at Siltara yet')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^(Call|WhatsApp) Ravi/ })).toBeNull();
  });

  it('one who never signed in is marked; when WhatsApp cannot open, the phone says so', async () => {
    await api('/v1/users', {
      method: 'POST',
      idempotent: true,
      body: { name: 'Naveen Sahu', mobile: '9826100050', role: 'supervisor', plantIds: [ids.plants.siltara] },
    });
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no app'));
    const mk = await boardTruck('CG 04 MK 2291');
    await wrap(<TruckDetailScreen id={mk.id} />);
    await screen.findByRole('header', { name: 'CG 04 MK 2291' });
    expect(screen.getByText('Supervisors at Siltara')).toBeOnTheScreen();
    expect(screen.getByLabelText('Naveen Sahu, supervisor, +91 98261 00050, not signed in yet')).toBeOnTheScreen();
    await press('WhatsApp Naveen Sahu');
    expect(await screen.findByText("Couldn't open WhatsApp")).toBeOnTheScreen();
  });
});
