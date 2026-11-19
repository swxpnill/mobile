// F5: notification hooks, safe links, and (Task 5) the list screen and Home bell.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, notificationPageSchema, renderNotification } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { ME_KEY, UnitBasisProvider } from '../src/api/hooks/me';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from '../src/api/hooks/notifications';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { openNotificationLink } from '../src/notifications/openLink';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { badgeText } from '../src/screens/notifications/Bell';
import { NotificationsScreen } from '../src/screens/notifications/NotificationsScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => undefined,
}));

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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const serverList = async () => (await api('/v1/notifications', { schema: notificationPageSchema })).items;

describe('Notifications screen (board 37)', () => {
  it('groups by IST day and shows the board copy; unread rows say so', async () => {
    const items = await serverList();
    await render(<NotificationsScreen />, { wrapper: Providers });
    expect(await screen.findByRole('header', { name: 'Today' })).toBeOnTheScreen();
    const first = items[0]!;
    const { title, body } = renderNotification(first, 'mt');
    const row = await screen.findByRole('button', { name: new RegExp(`^${esc(title)}\. `) });
    expect(within(row).getByText(body)).toBeOnTheScreen();
    expect(row.props.accessibilityLabel.endsWith(', unread')).toBe(first.readAt === null);
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(items.filter((n) => n.readAt === null).length);
  });

  it('tapping an unread row marks it read and opens its link', async () => {
    const target = (await serverList()).find((n) => n.readAt === null)!;
    await render(<NotificationsScreen />, { wrapper: Providers });
    const { title } = renderNotification(target, 'mt');
    await fireEvent.press((await screen.findAllByRole('button', { name: new RegExp(`^${esc(title)}\. .*, unread$`) }))[0]!);
    expect(mockRouter.push).toHaveBeenCalledWith(target.deepLink);
    await waitFor(async () => expect((await serverList()).find((n) => n.id === target.id)!.readAt).not.toBeNull());
  });

  it('Mark all read clears every dot and hides itself', async () => {
    await render(<NotificationsScreen />, { wrapper: Providers });
    await fireEvent.press(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryAllByTestId('unread-dot')).toHaveLength(0));
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('switching to kg re-renders every row with no new list request (Review Focus 4)', async () => {
    const dispatched = (await serverList()).find((n) => n.kind === 'truck.dispatched')!;
    await render(<NotificationsScreen />, { wrapper: Providers });
    await screen.findByText(renderNotification(dispatched, 'mt').body);
    const spy = jest.spyOn(mock.transport, 'request');
    await act(async () => {
      await api('/v1/me/preferences', { method: 'PATCH', body: { unitBasis: 'kg' } });
      await client.invalidateQueries({ queryKey: ME_KEY });
    });
    expect(await screen.findByText(renderNotification(dispatched, 'kg').body)).toBeOnTheScreen();
    expect(spy.mock.calls.filter(([r]) => r.path.startsWith('/v1/notifications?') || r.path === '/v1/notifications')).toEqual([]);
    spy.mockRestore();
  });

  it('empty: a person with nothing yet', async () => {
    mock = await createMockApi({ clock: createFakeClock(NOW) }); // no demo orders: nothing has happened
    setMockApi(mock);
    await signIn(ids.users.rajesh);
    await render(<NotificationsScreen />, { wrapper: Providers });
    expect(await screen.findByText('No notifications yet')).toBeOnTheScreen();
    expect(screen.getByText('Orders, trucks and payments that need you show here.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });
});

describe('Bell and entry points', () => {
  it('Home bell says how many are new and opens the list', async () => {
    const unreadNow = await serverUnread();
    await render(<HomeScreen />, { wrapper: Providers });
    const bell = await screen.findByRole('button', { name: `Notifications, ${unreadNow} new` });
    expect(within(bell).getByText(badgeText(unreadNow))).toBeOnTheScreen();
    await fireEvent.press(bell);
    expect(mockRouter.push).toHaveBeenCalledWith('/notifications');
  });

  it('badge text caps at 9+', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(12)).toBe('9+');
  });

  it('a supervisor reaches the list from Profile', async () => {
    await signIn(ids.users.ravi);
    await render(<ProfileScreen />, { wrapper: Providers });
    await fireEvent.press(await screen.findByRole('button', { name: /^Notifications/ }));
    expect(mockRouter.push).toHaveBeenCalledWith('/notifications');
  });
});
