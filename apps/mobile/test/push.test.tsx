// F5 Task 6: simulated push — registration, phone notifications, silent sync, taps, permission.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { type Order, SAMPLE_MASTERS, SAMPLE_WORLD, notificationPageSchema, orderListSchema, orderSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { signInAsDemo } from '../src/api/demo';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { ASKED_KEY } from '../src/notifications/permission';
import { usePush } from '../src/notifications/usePush';
import * as sync from '../src/offline/useSync';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({}), useFocusEffect: () => undefined }));

const NOW = Date.UTC(2026, 10, 19, 6, 0);
const { ids } = SAMPLE_WORLD;
const N = Notifications as jest.Mocked<typeof Notifications>;
let mock: MockApi;
let client: QueryClient;
let requestSync: jest.SpyInstance;

function Probe() {
  usePush();
  return null;
}
const mount = () =>
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>
            <Probe />
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}
/** Someone acting on another phone. */
async function other(userId: string) {
  const { accessToken } = await mock.controls.signInAs(userId, `other-phone-${userId.slice(-4)}`);
  let n = 0;
  return (method: 'GET' | 'POST', path: string, body?: unknown) =>
    mock.transport.request({ method, path, body, headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': `k-${Date.now()}-${++n}-${Math.random()}` } });
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));

async function payAsPriya() {
  const priya = await other(ids.users.priya);
  const res = await priya('POST', `/v1/brokers/${SAMPLE_MASTERS.ids.parties.rkAgarwal}/payments`, {
    paidRupees: 1_000,
    tdsRupees: 0,
    mode: 'cash',
    utr: null,
    paidOn: '2026-11-19',
  });
  expect(res.status).toBe(201);
}
async function assignAtSiltara(vehicleNo: string) {
  const owner = await other(ids.users.rajesh);
  const list = orderListSchema.parse((await owner('GET', '/v1/orders?status=all')).body);
  const id = list.items.find((o) => o.number.endsWith('0142'))!.id;
  const o: Order = orderSchema.parse((await owner('GET', `/v1/orders/${id}`)).body);
  const sub = o.subOrders.find((s) => s.companyCode === 'AIP')!;
  const line = sub.lines.find((l) => l.pendingKg > 0)!;
  const res = await owner('POST', `/v1/sub-orders/${sub.id}/trucks`, {
    vehicleNo,
    transporterId: null,
    driverName: 'Ramesh',
    driverPhone: '98261 00099',
    lrNo: null,
    plan: [{ orderLineId: line.id, plannedKg: 1_000 }],
  });
  expect(res.status).toBe(201);
}
const shownTitles = () => N.scheduleNotificationAsync.mock.calls.map(([r]) => r.content.title);

let nowSpy: jest.SpyInstance;
beforeAll(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterAll(() => nowSpy.mockRestore());

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  requestSync = jest.spyOn(sync, 'requestSync').mockImplementation(() => undefined);
});

afterEach(() => {
  requestSync.mockRestore();
  client.clear();
  setMockApi(null);
});

/** Waits until this phone's registration reached the mock. */
async function waitRegistered(times = 1) {
  await waitFor(() => expect(N.getPermissionsAsync.mock.calls.length).toBeGreaterThanOrEqual(times));
}

describe('push (simulated, F5 Ruling 1)', () => {
  it('owner: a payment by Priya shows as a phone notification in the board copy', async () => {
    await signIn(ids.users.rajesh);
    await mount();
    await waitRegistered();
    await payAsPriya();
    await flush();
    expect(shownTitles()).toEqual(['₹1,000 paid to R.K. Agarwal']);
    const [req] = N.scheduleNotificationAsync.mock.calls[0]!;
    expect(req.trigger).toBeNull();
    expect(req.content.data).toMatchObject({ deepLink: `/parties/${SAMPLE_MASTERS.ids.parties.rkAgarwal}` });
  });

  it('supervisor: an assignment at their plant syncs the phone and shows "assigned"', async () => {
    await signIn(ids.users.ravi);
    await mount();
    await waitRegistered();
    await assignAtSiltara('CG 04 ZZ 1111');
    await flush();
    expect(requestSync).toHaveBeenCalled();
    expect(shownTitles()).toEqual(['CG 04 ZZ 1111 assigned']);
  });

  it('person switch on this phone: the previous person’s pushes stop (Review Focus 2)', async () => {
    await signIn(ids.users.rajesh);
    await mount();
    await waitRegistered();
    await act(async () => signInAsDemo(ids.users.ravi));
    await waitRegistered(2);
    await payAsPriya(); // money: Rajesh would be told, Ravi never is
    await flush();
    expect(shownTitles()).toEqual([]);
    await assignAtSiltara('CG 04 ZZ 2222');
    await flush();
    expect(shownTitles()).toEqual(['CG 04 ZZ 2222 assigned']);
  });

  it('a tap marks the notification read and opens its screen; a foreign link opens the list', async () => {
    await signIn(ids.users.rajesh);
    const n = (await api('/v1/notifications', { schema: notificationPageSchema })).items.find((x) => x.readAt === null)!;
    await mount();
    await waitRegistered();
    const onTap = N.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
    const tap = (data: object) => onTap({ notification: { request: { content: { data } } } } as unknown as Notifications.NotificationResponse);
    await act(async () => tap({ notificationId: n.id, deepLink: n.deepLink }));
    expect(mockRouter.push).toHaveBeenLastCalledWith(n.deepLink);
    await waitFor(async () => {
      const after = (await api('/v1/notifications', { schema: notificationPageSchema })).items.find((x) => x.id === n.id)!;
      expect(after.readAt).not.toBeNull();
    });
    await act(async () => tap({ notificationId: 'x-other', deepLink: 'https://evil.example' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/notifications');
  });

  it('the system prompt is shown once per phone, across sign-ins', async () => {
    N.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false, canAskAgain: true } as never);
    await signIn(ids.users.rajesh);
    const view = await mount();
    await waitFor(() => expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    expect(await AsyncStorage.getItem(ASKED_KEY)).toBe('1');
    await view.unmount();
    await act(async () => signInAsDemo(ids.users.priya));
    await mount();
    await waitRegistered(2);
    await flush();
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('sign-out says goodbye for this phone, and still signs out when offline', async () => {
    await signIn(ids.users.rajesh);
    await mount();
    await waitRegistered();
    const deviceId = useSession.getState().deviceId;
    const spy = jest.spyOn(mock.transport, 'request');
    await act(async () => useSession.getState().signOut());
    await flush();
    expect(spy.mock.calls.some(([r]) => r.method === 'DELETE' && r.path === `/v1/notifications/push-token/${deviceId}`)).toBe(true);
    spy.mockRestore();

    await signIn(ids.users.rajesh);
    mock.controls.setOffline(true);
    await act(async () => useSession.getState().signOut());
    expect(useSession.getState().status).toBe('signedOut');
  });
});
