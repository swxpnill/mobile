// F5 Task 7: background sync for capture roles, and one sync run at a time on a phone.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as BackgroundTask from 'expo-background-task';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { SAMPLE_WORLD, tasksPageSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { SYNC_TASK, registerBackgroundSync, runBackgroundSync, useBackgroundSync } from '../src/offline/backgroundSync';
import { openDeviceStore, resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { withSyncLock } from '../src/offline/syncLock';

const NOW = Date.UTC(2026, 10, 19, 6, 0);
const { ids } = SAMPLE_WORLD;
const BT = BackgroundTask as jest.Mocked<typeof BackgroundTask>;
const TM = TaskManager as jest.Mocked<typeof TaskManager>;
let mock: MockApi;
let client: QueryClient;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}

/** Ravi has an AT_GATE for one of his tasks waiting on this phone. */
async function pendingAtGate(): Promise<string> {
  // The phone holds only trucks it has pulled: one sync first, as the app's first run would.
  expect(await runBackgroundSync()).toBe('synced');
  const task = (await api('/v1/supervisor/tasks', { schema: tasksPageSchema })).items[0]!;
  const store = await openDeviceStore(ids.users.ravi);
  const eventId = globalThis.crypto.randomUUID();
  await store.saveCapture({ eventId, truckId: task.truckId, type: 'AT_GATE', payload: {}, capturedAtDevice: new Date(NOW).toISOString() });
  return eventId;
}

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
  resetDeviceStoresForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  mock = await createMockApi({ clock: createFakeClock(NOW), seedOrders: true });
  setTransport(null);
  setMockApi(mock);
  BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Available);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('withSyncLock', () => {
  it('runs one at a time, in order, and a failure does not block the next', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withSyncLock(
      () =>
        new Promise<void>((r) => {
          order.push('first starts');
          release = () => {
            order.push('first ends');
            r();
          };
        }),
    );
    const failing = withSyncLock(async () => {
      order.push('second runs');
      throw new Error('boom');
    });
    const third = withSyncLock(async () => order.push('third runs'));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['first starts']); // the others wait their turn
    release();
    await first;
    await expect(failing).rejects.toThrow('boom');
    await third;
    expect(order).toEqual(['first starts', 'first ends', 'second runs', 'third runs']);
  });
});

describe('registration (F5 Ruling 10)', () => {
  it('registers every 15 minutes when the OS allows it; not at all when Restricted (Expo Go)', async () => {
    expect(await registerBackgroundSync()).toBe(true);
    expect(BT.registerTaskAsync).toHaveBeenCalledWith(SYNC_TASK, { minimumInterval: 15 });
    BT.registerTaskAsync.mockClear();
    BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Restricted);
    expect(await registerBackgroundSync()).toBe(false);
    expect(BT.registerTaskAsync).not.toHaveBeenCalled();
  });

  function Probe() {
    useBackgroundSync();
    return null;
  }
  const mount = () =>
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

  it('a supervisor registers it; city staff do not; sign-out removes it', async () => {
    await signIn(ids.users.ravi);
    const view = await mount();
    await waitFor(() => expect(BT.registerTaskAsync).toHaveBeenCalledTimes(1), { timeout: 4000 });
    TM.isTaskRegisteredAsync.mockResolvedValue(true);
    await useSession.getState().signOut();
    await waitFor(() => expect(BT.unregisterTaskAsync).toHaveBeenCalledWith(SYNC_TASK));
    await view.unmount();

    jest.clearAllMocks();
    BT.getStatusAsync.mockResolvedValue(BackgroundTask.BackgroundTaskStatus.Available);
    // The app wipes cached data on a person switch (UnitBasisProvider); this probe starts clean instead.
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    await signIn(ids.users.priya);
    await mount();
    await waitFor(() => expect(TM.isTaskRegisteredAsync).toHaveBeenCalled(), { timeout: 4000 });
    expect(BT.registerTaskAsync).not.toHaveBeenCalled();
  });
});

describe('runBackgroundSync', () => {
  it('skips when no one is signed in, or the role does not weigh', async () => {
    expect(await runBackgroundSync()).toBe('skipped');
    await signIn(ids.users.priya);
    expect(await runBackgroundSync()).toBe('skipped');
  });

  it('with no screen up: sends what waits on the phone', async () => {
    await signIn(ids.users.ravi);
    const eventId = await pendingAtGate();
    expect(await runBackgroundSync()).toBe('synced');
    const row = (await (await openDeviceStore(ids.users.ravi)).outbox()).find((r) => r.eventId === eventId)!;
    expect(row.status).toBe('accepted');
  });

  it('two runs at once send each event once (Review Focus 3)', async () => {
    await signIn(ids.users.ravi);
    const eventId = await pendingAtGate();
    mock.controls.setLatency(30);
    const spy = jest.spyOn(mock.transport, 'request');
    const results = await Promise.all([runBackgroundSync(), runBackgroundSync()]);
    expect(results).toEqual(['synced', 'synced']);
    const pushes = spy.mock.calls.filter(
      ([r]) => r.path === '/v1/weighments/sync' && JSON.stringify(r.body).includes(eventId),
    );
    expect(pushes).toHaveLength(1);
    spy.mockRestore();
  });
});
