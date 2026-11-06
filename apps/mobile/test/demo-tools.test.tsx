import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, meSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import * as demo from '../src/api/demo';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { useNetStatus } from '../src/api/netStatus';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { CompaniesScreen } from '../src/screens/admin/CompaniesScreen';
import { DemoToolsScreen } from '../src/screens/DemoToolsScreen';
import { MoreScreen } from '../src/screens/MoreScreen';
import { DemoSignInScreen } from '../src/screens/DemoSignInScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { SignInScreen } from '../src/screens/SignInScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { Sheet } from '../src/ui/Sheet';
import { WakingBanner } from '../src/ui/WakingBanner';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
// The signed-in stack Demo tools sits in: (tabs) underneath, demo-tools on top.
const mockNavigation = {
  getState: () => ({
    key: 'stack-1',
    index: 1,
    routeNames: ['(tabs)', 'demo-tools'],
    routes: [
      { key: 'tabs-1', name: '(tabs)' },
      { key: 'demo-1', name: 'demo-tools' },
    ],
    routeKeySeq: 2,
    stale: false,
    type: 'stack',
  }),
  dispatch: jest.fn(),
};
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    useNavigation: () => mockNavigation,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

const { ids } = SAMPLE_WORLD;

/** The tab a person switch from inside the app reset the signed-in stack to (fresh tabs). */
function freshStartTab(): string | undefined {
  const action = mockNavigation.dispatch.mock.calls.at(-1)?.[0] as
    | { type: string; payload: { routes: { name: string; state?: { routes: { name: string }[] } }[] } }
    | undefined;
  if (action?.type !== 'RESET') return undefined;
  const [only, ...rest] = action.payload.routes;
  return rest.length === 0 && only?.name === '(tabs)' ? only.state?.routes[0]?.name : undefined;
}
let mock: MockApi;
let client: QueryClient;

async function signIn(userId: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await useSession.getState().signIn(await mock.controls.signInAs(userId, deviceId));
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
          <UnitBasisProvider>{ui}</UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)) });
  setTransport(null);
  setMockApi(mock); // the app's own mock: transport and controls are the same instance
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  await signIn(ids.users.rajesh);
});

afterEach(() => {
  client.clear();
  setMockApi(null);
});

describe('demoToolsEnabled', () => {
  it('only in mock mode, and in release builds only with EXPO_PUBLIC_DEMO_TOOLS=1', () => {
    expect(demo.demoToolsEnabled({ mode: 'mock', dev: true, flag: undefined })).toBe(true);
    expect(demo.demoToolsEnabled({ mode: 'mock', dev: false, flag: undefined })).toBe(false);
    expect(demo.demoToolsEnabled({ mode: 'mock', dev: false, flag: '1' })).toBe(true);
    expect(demo.demoToolsEnabled({ mode: 'http', dev: true, flag: '1' })).toBe(false);
  });

  it('More shows the Demo tools row when enabled and hides it when not', async () => {
    const view = await wrap(<MoreScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Demo tools' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/demo-tools');
    await view.unmount();

    // A release build without EXPO_PUBLIC_DEMO_TOOLS=1.
    const g = globalThis as { __DEV__?: boolean };
    g.__DEV__ = false;
    try {
      await wrap(<MoreScreen />);
      await screen.findByText('Rajesh Agrawal');
      expect(screen.queryByRole('button', { name: 'Demo tools' })).toBeNull();
    } finally {
      g.__DEV__ = true;
    }
  });

  it('the supervisor Profile has the row too', async () => {
    await signIn(ids.users.ravi);
    await wrap(<ProfileScreen />);
    expect(await screen.findByRole('button', { name: 'Demo tools' })).toBeOnTheScreen();
  });
});

describe('Sign in as', () => {
  it('Sign in as Ravi Verma lands on My tasks as Ravi', async () => {
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Ravi Verma/ }));
    await waitFor(() => expect(freshStartTab()).toBe('tasks'));
    const me = meSchema.parse(await api('/v1/me'));
    expect(me.name).toBe('Ravi Verma');
  });

  it('marks you and deactivated people, and does not offer them', async () => {
    await mock.transport.request({
      method: 'POST',
      path: `/v1/users/${ids.users.mohan}/deactivate`,
      headers: { authorization: `Bearer ${useSession.getState().accessToken}` },
    });
    await wrap(<DemoToolsScreen />);
    expect(await screen.findByRole('button', { name: /^Rajesh Agrawal.*, you$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Mohan Kurre.*, deactivated$/ })).toBeDisabled();
  });
});

describe('Network', () => {
  it('Offline on → next screen fetch shows the network error; off → Try again succeeds', async () => {
    const tools = await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('switch', { name: 'Offline' }));
    expect(mock.controls.getState().offline).toBe(true);
    await tools.unmount();

    await wrap(<CompaniesScreen />);
    expect(await screen.findByText(/Can't reach the server/)).toBeOnTheScreen();
    mock.controls.setOffline(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Aarav Ispat Pvt Ltd/ })).toBeOnTheScreen();
  });

  it('Latency 6 s shows the "Waking server…" banner after 5 s', async () => {
    const tools = await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('radio', { name: '6 s' }));
    expect(mock.controls.getState().latencyMs).toBe(6000);
    await tools.unmount();

    jest.useFakeTimers();
    try {
      await wrap(<WakingBanner />);
      const call = api('/v1/meta', { auth: false });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_900);
      });
      expect(screen.queryByText('Waking server…')).toBeNull();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByText('Waking server…')).toBeOnTheScreen();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
        await call;
      });
      expect(screen.queryByText('Waking server…')).toBeNull();
      expect(useNetStatus.getState().pending).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Next request fails with', () => {
  it('STALE is armed for the next save, shown as armed, and fires once', async () => {
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('radio', { name: /Someone else changed this/ }));
    expect(mock.controls.getState().failNext).toMatchObject({
      kind: 'http',
      status: 409,
      code: 'STALE',
      writesOnly: true,
    });
    // A read passes; the next write gets STALE; then it is disarmed.
    await expect(api('/v1/companies')).resolves.toBeDefined();
    await expect(
      api('/v1/settings', { method: 'PATCH', body: { agedOrderDays: 12 } }),
    ).rejects.toMatchObject({ code: 'STALE' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /^None/ })).toBeChecked());
  });

  it('Connection drops makes the next request fail like a lost signal', async () => {
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('radio', { name: /Connection drops/ }));
    await expect(api('/v1/companies')).rejects.toMatchObject({ name: 'NetworkError' });
    await expect(api('/v1/companies')).resolves.toBeDefined();
  });
});

describe('Reset demo data', () => {
  it('asks first, then restores 4 companies after one was added and signs out', async () => {
    await api('/v1/companies', {
      method: 'POST',
      idempotent: true,
      body: { code: 'BSP', name: 'Bhilai Steel Products', gstin: null, orderPrefix: 'SO-BSP' },
    });
    expect((await api<unknown[]>('/v1/companies')).length).toBe(5);

    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reset demo data' }));
    // Nothing happens until confirmed.
    expect((await api<unknown[]>('/v1/companies')).length).toBe(5);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reset and sign out' }));
    await waitFor(() => expect(useSession.getState().status).toBe('signedOut'));

    await signIn(ids.users.rajesh);
    expect((await api<unknown[]>('/v1/companies')).length).toBe(4);
  });

  it('Cancel keeps everything', async () => {
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reset demo data' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useSession.getState().status).toBe('signedIn');
    expect(screen.queryByRole('button', { name: 'Reset and sign out' })).toBeNull();
  });
});

describe('Demo sign-in from the Sign in screen', () => {
  it('signed out, the Sign in screen offers sample people and signs in as Ravi without a code', async () => {
    await useSession.getState().signOut();
    const view = await wrap(<SignInScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: 'Sign in as a sample person' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith('/demo-sign-in');
    await view.unmount();

    await wrap(<DemoSignInScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Ravi Verma/ }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/tasks'));
    expect(useSession.getState().status).toBe('signedIn');
    expect(meSchema.parse(await api('/v1/me')).name).toBe('Ravi Verma');
  });

  it('no shortcut on Sign in when demo tools are off', async () => {
    await useSession.getState().signOut();
    const g = globalThis as { __DEV__?: boolean };
    g.__DEV__ = false;
    try {
      await wrap(<SignInScreen />);
      await screen.findByText('Sign in');
      expect(screen.queryByRole('button', { name: 'Sign in as a sample person' })).toBeNull();
    } finally {
      g.__DEV__ = true;
    }
  });
});

describe('Task 10 review fixes', () => {
  it('I2: switching person turns simulated Offline off, so the new person is not stranded', async () => {
    mock.controls.setOffline(true);
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Ravi Verma/ }));
    await waitFor(() => expect(freshStartTab()).toBe('tasks'));
    expect(mock.controls.getState().offline).toBe(false);
    expect(meSchema.parse(await api('/v1/me')).name).toBe('Ravi Verma');
  });

  it('M5: the previous refresh token is revoked even with a failure armed, which stays armed', async () => {
    const previous = useSession.getState().refreshToken!;
    mock.controls.failNext(409, 'STALE', { writesOnly: true });
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Ravi Verma/ }));
    await waitFor(() => expect(freshStartTab()).toBe('tasks'));
    await waitFor(() => expect(mock.controls.getState().failNext).toMatchObject({ code: 'STALE' }));
    mock.controls.clearFailNext();
    const res = await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/refresh',
      headers: {},
      body: { refreshToken: previous, deviceId: await useSession.getState().ensureDeviceId() },
    });
    expect(res.status).toBe(401);
  });

  it('I1: a sheet never shows over the fingerprint lock', async () => {
    const { Text } = jest.requireActual('react-native');
    await wrap(
      <Sheet visible title="Reset demo data?" onClose={() => undefined}>
        <Text>Inside</Text>
      </Sheet>,
    );
    expect(await screen.findByText('Inside')).toBeOnTheScreen();
    await act(async () => {
      useSession.getState().lock();
    });
    expect(screen.queryByText('Inside')).toBeNull();
  });

  it('M4: a 401 that lands after a person switch is not retried as the new person', async () => {
    let calls = 0;
    let firstAuth: string | undefined;
    const rajeshToken = useSession.getState().accessToken;
    setTransport({
      request: async (req) => {
        if (req.path === '/v1/settings' && req.method === 'PATCH') {
          calls += 1;
          firstAuth ??= req.headers.authorization;
          if (calls === 1) {
            // While the save is out, the tester switches to Priya; the old token then expires.
            await signIn(ids.users.priya);
            return { status: 401, headers: {}, body: { code: 'UNAUTHENTICATED', message: 'x' } };
          }
        }
        return mock.transport.request(req);
      },
    });
    await expect(
      api('/v1/settings', { method: 'PATCH', body: { agedOrderDays: 12 } }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(firstAuth).toBe(`Bearer ${rajeshToken}`);
    expect(calls).toBe(1);
    setTransport(null);
  });
});

describe('F1.11 demo follow-ups', () => {
  it('a double tap on a person starts one switch, not two', async () => {
    let finish!: () => void;
    const spy = jest
      .spyOn(demo, 'signInAsDemo')
      .mockImplementation(() => new Promise<void>((r) => (finish = r)));
    try {
      await wrap(<DemoToolsScreen />);
      const ravi = await screen.findByRole('button', { name: /^Ravi Verma/ });
      await act(async () => {
        fireEvent.press(ravi);
        fireEvent.press(ravi);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      await act(async () => finish());
    } finally {
      spy.mockRestore();
    }
  });

  it('when the people list fails to load, Try again loads it', async () => {
    const spy = jest
      .spyOn(mock.controls, 'listUsers')
      .mockRejectedValueOnce(new Error('boom'));
    try {
      await wrap(<DemoToolsScreen />);
      await fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: /^Ravi Verma/ })).toBeTruthy();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('Sign in as says so when demo data is unavailable, instead of spinning forever', async () => {
    await useSession.getState().signOut();
    const spy = jest.spyOn(demo, 'getMockControls').mockResolvedValue(null);
    try {
      await wrap(<DemoSignInScreen />);
      expect(await screen.findByText(/Sample people aren't available/)).toBeTruthy();
      expect(screen.queryByLabelText('Loading')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('demo routes redirect away when demo tools are off', async () => {
    const g = globalThis as { __DEV__?: boolean };
    g.__DEV__ = false;
    try {
      const DemoToolsRoute = jest.requireActual('../app/(app)/demo-tools').default;
      const DemoSignInRoute = jest.requireActual('../app/(auth)/demo-sign-in').default;
      const a = await wrap(<DemoToolsRoute />);
      expect(screen.getByTestId('redirect').props.children).toBe('/');
      await a.unmount();
      await wrap(<DemoSignInRoute />);
      expect(screen.getByTestId('redirect').props.children).toBe('/sign-in');
    } finally {
      g.__DEV__ = true;
    }
  });
});

describe('F1.11 back stack', () => {
  it('switching from Demo tools resets the signed-in stack to fresh tabs on the new first tab', async () => {
    await wrap(<DemoToolsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Ravi Verma/ }));
    await waitFor(() => expect(freshStartTab()).toBe('tasks'));
    const reset = mockNavigation.dispatch.mock.calls.at(-1)![0] as {
      payload: { key: string; index: number; routeNames: string[]; stale: boolean };
    };
    // A complete state, as this router requires: same stack, one route, not stale.
    expect(reset.payload).toMatchObject({
      key: 'stack-1',
      index: 0,
      routeNames: ['(tabs)', 'demo-tools'],
      stale: false,
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('from the signed-out Sign in as screen it opens the first tab with the router, no reset', async () => {
    await useSession.getState().signOut();
    await wrap(<DemoSignInScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Ravi Verma/ }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/tasks'));
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();
  });
});
