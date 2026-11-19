// F5: notification hooks, safe links, and (Task 5) the list screen and Home bell.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, notificationPageSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from '../src/api/hooks/notifications';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { openNotificationLink } from '../src/notifications/openLink';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const NOW = Date.UTC(2026, 10, 19, 6, 0); // Thu 19 Nov 2026, 11:30 IST
const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>{children}</UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
}
const serverUnread = async () =>
  (await api('/v1/notifications', { schema: notificationPageSchema })).items.filter((n) => n.readAt === null).length;

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
  await signIn(ids.users.rajesh);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('notification hooks', () => {
  it('unread count matches the server; mark one read lowers it by one, mark all to zero', async () => {
    const expected = await serverUnread();
    expect(expected).toBeGreaterThan(1);
    const { result } = await renderHook(
      () => ({ count: useUnreadCount(), list: useNotifications(), read: useMarkRead(), all: useMarkAllRead() }),
      { wrapper: Providers },
    );
    await waitFor(() => expect(result.current.count.data).toBe(expected));
    await waitFor(() => expect(result.current.list.data?.pages[0]?.items.length).toBeGreaterThan(0));

    const unreadRow = result.current.list.data!.pages[0]!.items.find((n) => n.readAt === null)!;
    await act(() => result.current.read.mutateAsync(unreadRow.id));
    await waitFor(() => expect(result.current.count.data).toBe(expected - 1));
    expect(await serverUnread()).toBe(expected - 1);

    // Marking an already-read row again changes nothing.
    await act(() => result.current.read.mutateAsync(unreadRow.id));
    await waitFor(() => expect(result.current.count.data).toBe(expected - 1));

    await act(() => result.current.all.mutateAsync(undefined));
    await waitFor(() => expect(result.current.count.data).toBe(0));
    expect(result.current.list.data!.pages[0]!.items.every((n) => n.readAt !== null)).toBe(true);
  });

  it('a supervisor sees only their own rows', async () => {
    await signIn(ids.users.ravi);
    const { result } = await renderHook(() => useNotifications(), { wrapper: Providers });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const n of result.current.data!.pages[0]!.items) expect(n.kind).toBe('truck.assigned');
  });
});

describe('openNotificationLink', () => {
  it('follows only allowed in-app routes', () => {
    const router = { push: jest.fn() };
    const id = '019a4c00-0003-7000-8000-000000000001';
    openNotificationLink(router, `/orders/${id}`);
    openNotificationLink(router, 'https://evil.example');
    openNotificationLink(router, '/users');
    openNotificationLink(router, undefined);
    expect(router.push.mock.calls.map((c) => c[0])).toEqual([`/orders/${id}`, '/notifications', '/notifications', '/notifications']);
  });
});
