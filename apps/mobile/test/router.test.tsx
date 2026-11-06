// The real tabs layout under expo-router's test harness: role redirects and the back button.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { router, Stack, useNavigation, useRootNavigationState } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from '@testing-library/react-native';
import { tokenPairSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import TabsLayout from '../app/(app)/(tabs)/_layout';
import { freshStartOn } from '../src/nav/freshStart';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { ThemeProvider } from '../src/theme/ThemeProvider';

let mock: MockApi;
let client: QueryClient;

async function signInAs(mobile: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await mock.transport.request({ method: 'POST', path: '/v1/auth/request-code', headers: {}, body: { mobile } });
  const res = await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/verify',
    headers: {},
    body: { mobile, code: '123456', deviceId },
  });
  await useSession.getState().signIn(tokenPairSchema.parse(res.body));
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>{children}</UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const tab = (name: string) => () => <Text>{`${name} screen`}</Text>;
const routes = {
  '(tabs)/_layout': TabsLayout,
  '(tabs)/home': tab('home'),
  '(tabs)/orders': tab('orders'),
  '(tabs)/new': tab('new'),
  '(tabs)/dispatch': tab('dispatch'),
  '(tabs)/more': tab('more'),
  '(tabs)/tasks': tab('tasks'),
  '(tabs)/done': tab('done'),
  '(tabs)/profile': tab('profile'),
};

beforeEach(async () => {
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)) });
  setTransport(mock.transport);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(() => client.clear());

describe('tabs layout', () => {
  it('a supervisor sent to /home lands on My tasks', async () => {
    await signInAs('9826100014');
    await renderRouter(routes, { initialUrl: '/home', wrapper: Providers });
    expect(await screen.findByText('tasks screen')).toBeOnTheScreen();
    expect(screen).toHavePathname('/tasks');
  });

  it('back from a supervisor’s first tab has nowhere to go (it does not bounce through Home)', async () => {
    await signInAs('9826100014');
    await renderRouter(routes, { initialUrl: '/tasks', wrapper: Providers });
    await screen.findByText('tasks screen');
    expect(router.canGoBack()).toBe(false);
  });

  it('back from Done returns to My tasks', async () => {
    await signInAs('9826100014');
    await renderRouter(routes, { initialUrl: '/tasks', wrapper: Providers });
    await screen.findByText('tasks screen');
    await act(async () => router.navigate('/done'));
    expect(await screen.findByText('done screen')).toBeOnTheScreen();
    await act(async () => router.back());
    expect(await screen.findByText('tasks screen')).toBeOnTheScreen();
  });

  it('an owner opens on Home', async () => {
    await signInAs('9826100012');
    await renderRouter(routes, { initialUrl: '/home', wrapper: Providers });
    expect(await screen.findByText('home screen')).toBeOnTheScreen();
    expect(router.canGoBack()).toBe(false);
  });
});

type NavState = { index?: number; routes: { name: string; state?: NavState }[] } | undefined;
let lastState: NavState;
let demoNav: Parameters<typeof freshStartOn>[0];
const tree = (st: NavState): string =>
  st ? `[${st.routes.map((r, i) => (i === st.index ? '*' : '') + r.name + tree(r.state)).join(',')}]` : '';

describe('person switch (F1.11)', () => {
  const stackRoutes = {
    _layout: function Root() {
      lastState = useRootNavigationState() as unknown as NavState;
      return <Stack screenOptions={{ headerShown: false }} />;
    },
    ...routes,
    'demo-tools': function DemoTools() {
      demoNav = useNavigation() as typeof demoNav;
      return <Text>demo screen</Text>;
    },
  };

  it('switching from Demo tools gives the new person fresh tabs: Back has nowhere to go', async () => {
    await signInAs('9826100014'); // Ravi, supervisor
    await renderRouter(stackRoutes, { initialUrl: '/tasks', wrapper: Providers });
    await screen.findByText('tasks screen');
    await act(async () => router.navigate('/profile'));
    await screen.findByText('profile screen');
    await act(async () => router.push('/demo-tools'));
    await screen.findByText('demo screen');

    // What DemoPeopleList does: new session, then a fresh start on the first tab.
    await act(async () => signInAs('9826100013')); // Priya, city staff
    await act(async () => freshStartOn(demoNav, 'home'));
    expect(await screen.findByText('home screen')).toBeOnTheScreen();
    // Android Back from the new person's first tab must leave the app, not visit a tab left
    // over from the previous person (a supervisor's Profile, or a hidden tab that redirects).
    await act(async () => {
      router.back();
    });
    const after = tree(lastState);
    expect(after).toBe('[*__root[*(tabs)[*home]]]');
  });
});
