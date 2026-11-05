// Regression tests for the Task 7 review findings.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { AppState, type AppStateStatus, Text } from 'react-native';
import {
  type Transport,
  type TransportResponse,
  NetworkError,
  meSchema,
  tokenPairSchema,
} from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { api } from '../src/api/client';
import { setTransport } from '../src/api/transport';
import { LOCK_AFTER_MS, useIdleLock } from '../src/auth/lock';
import { REFRESH_KEY, resetSessionForTests, useSession } from '../src/auth/session';
import { setDevicePrefs } from '../src/prefs/device';
import { LockScreen } from '../src/screens/LockScreen';
import { VerifyScreen } from '../src/screens/VerifyScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ mobile: '+919826100012' }),
}));

const MIN = 60_000;
let mock: MockApi;
let clock: ReturnType<typeof createFakeClock>;

async function signIn(mobile = '9826100012') {
  const deviceId = await useSession.getState().ensureDeviceId();
  await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/request-code',
    headers: {},
    body: { mobile },
  });
  const res = await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/verify',
    headers: {},
    body: { mobile, code: '123456', deviceId },
  });
  await useSession.getState().signIn(tokenPairSchema.parse(res.body));
}

beforeEach(async () => {
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  mock = await createMockApi({ clock });
  setTransport(mock.transport);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('C1: fingerprint lock cannot be skipped by reopening the app', () => {
  it('cold start with fingerprint unlock on resumes LOCKED, not signed in', async () => {
    await setDevicePrefs({ fingerprint: true });
    await signIn();
    resetSessionForTests(); // app killed
    await useSession.getState().init();
    expect(useSession.getState().status).toBe('locked');
  });

  it('cold start with fingerprint unlock off resumes signed in', async () => {
    await signIn();
    resetSessionForTests();
    await useSession.getState().init();
    expect(useSession.getState().status).toBe('signedIn');
  });

  it('offline cold start with fingerprint on is also locked', async () => {
    await setDevicePrefs({ fingerprint: true });
    await signIn();
    resetSessionForTests();
    mock.controls.setOffline(true);
    await useSession.getState().init();
    expect(useSession.getState().status).toBe('locked');
  });
});

describe('I1: sign-out racing a refresh stays signed out', () => {
  it('refresh in flight, then sign out → nothing stored, nothing in memory, rotated token revoked', async () => {
    await signIn();
    clock.advance(15 * MIN);
    // The refresh reaches the server (which rotates R1→R2) but its answer arrives only after
    // sign-out has finished — the http-mode race.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let rotated: string | undefined;
    setTransport({
      async request(req) {
        const res = await mock.transport.request(req);
        if (req.path === '/v1/auth/refresh') {
          rotated = (res.body as { refreshToken?: string }).refreshToken;
          await gate;
        }
        return res;
      },
    });
    const refreshing = useSession
      .getState()
      .refresh()
      .catch(() => false);
    await new Promise((r) => setTimeout(r, 10)); // refresh is now waiting on the gate
    const signingOut = useSession.getState().signOut();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([refreshing, signingOut]);
    expect(useSession.getState()).toMatchObject({
      status: 'signedOut',
      accessToken: undefined,
      refreshToken: undefined,
    });
    expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBeNull();
    // The successor the server issued during the race is revoked too.
    const reuse = await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/refresh',
      headers: {},
      body: { refreshToken: rotated, deviceId: useSession.getState().deviceId },
    });
    expect(reuse.status).toBe(401);
    resetSessionForTests();
    await useSession.getState().init();
    expect(useSession.getState().status).toBe('signedOut');
  });
});

describe('I2: refresh cannot hang the app', () => {
  it('a refresh that never answers fails with NetworkError after 90 s', async () => {
    await signIn();
    jest.useFakeTimers();
    setTransport({ request: () => new Promise<TransportResponse>(() => {}) });
    const outcome = expect(useSession.getState().refresh()).rejects.toBeInstanceOf(NetworkError);
    await jest.advanceTimersByTimeAsync(90_000);
    await outcome;
  });

  it('cold start does not wait more than 8 s on a slow refresh: the app opens signed in', async () => {
    await signIn();
    resetSessionForTests();
    jest.useFakeTimers();
    setTransport({ request: () => new Promise<TransportResponse>(() => {}) });
    const init = useSession.getState().init();
    await jest.advanceTimersByTimeAsync(8_000);
    await init;
    expect(useSession.getState().status).toBe('signedIn');
  });
});

describe('I4: a late 401 for an already-replaced token does not rotate again', () => {
  it('only one refresh when a 401 for the old token arrives after the refresh finished', async () => {
    await signIn();
    clock.advance(15 * MIN);
    let refreshes = 0;
    let releaseFirst!: () => void;
    const held = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let meCalls = 0;
    const t: Transport = {
      async request(req) {
        if (req.path === '/v1/auth/refresh') refreshes += 1;
        if (req.path === '/v1/me' && ++meCalls === 1) {
          const res = await mock.transport.request(req); // 401 with the old token
          await held; // …delivered only after the other request's refresh is done
          return res;
        }
        return mock.transport.request(req);
      },
    };
    setTransport(t);
    const slow = api('/v1/me', { schema: meSchema });
    await new Promise((r) => setTimeout(r, 10));
    const fast = await api('/v1/me', { schema: meSchema }); // 401 → refresh → retry
    releaseFirst();
    const late = await slow;
    expect(fast.name).toBe('Rajesh Agrawal');
    expect(late.name).toBe('Rajesh Agrawal');
    expect(refreshes).toBe(1);
  });
});

describe('Upgraded: idle lock', () => {
  function Probe() {
    const touch = useIdleLock();
    return <Text onPress={touch}>probe</Text>;
  }

  async function mount() {
    let handler: (s: AppStateStatus) => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, h) => {
      handler = h as (s: AppStateStatus) => void;
      return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
    });
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await screen.findByText('probe');
    return (s: AppStateStatus) => handler(s);
  }

  beforeEach(async () => {
    await setDevicePrefs({ fingerprint: true });
    await signIn();
  });

  it('10 min idle on screen + 6 min in background → locked on return (idle time is not reset by backgrounding)', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const emit = await mount();
    now += 10 * MIN;
    await act(async () => emit('background'));
    now += 6 * MIN;
    await act(async () => emit('active'));
    expect(useSession.getState().status).toBe('locked');
  });

  it('an untouched screen locks by itself after 15 min in the foreground', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(LOCK_AFTER_MS + 30_000);
    });
    expect(useSession.getState().status).toBe('locked');
  });

  it('a touch keeps it unlocked; a signed-out user is never locked', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const emit = await mount();
    now += 14 * MIN;
    await fireEvent.press(screen.getByText('probe'));
    now += 14 * MIN;
    await act(async () => emit('active'));
    expect(useSession.getState().status).toBe('signedIn');
    await useSession.getState().signOut();
    now += 60 * MIN;
    await act(async () => emit('active'));
    expect(useSession.getState().status).toBe('signedOut');
  });
});

describe('I5: tenant picker is not a dead end', () => {
  it('an error after choosing a company group goes back to the code screen with the error', async () => {
    const other = await mock.fixtures.createTenant('Bansal Metals');
    await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/request-code',
      headers: {},
      body: { mobile: other.ownerMobile },
    });
    const owner = await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/verify',
      headers: {},
      body: {
        mobile: other.ownerMobile,
        code: '123456',
        deviceId: '019a4c00-00ff-7000-8000-00000000000b',
      },
    });
    await mock.transport.request({
      method: 'POST',
      path: '/v1/users',
      headers: {
        authorization: `Bearer ${(owner.body as { accessToken: string }).accessToken}`,
        'idempotency-key': 'k1',
      },
      body: { name: 'Rajesh A', mobile: '9826100012', role: 'city_staff', plantIds: [] },
    });
    await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/request-code',
      headers: {},
      body: { mobile: '9826100012' },
    });

    await render(
      <ThemeProvider>
        <VerifyScreen />
      </ThemeProvider>,
    );
    await fireEvent.changeText(await screen.findByLabelText('One-time code'), '123456');
    await screen.findByText('Which company group?');
    mock.controls.setOffline(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Bansal Metals' }));
    expect(await screen.findByText('Enter the code')).toBeOnTheScreen();
    expect(
      screen.getByText("Can't reach the server. Check your connection and try again."),
    ).toBeOnTheScreen();
  });
});

describe('Lock screen', () => {
  it('a recognised fingerprint unlocks', async () => {
    await signIn();
    useSession.getState().lock();
    await render(
      <ThemeProvider>
        <LockScreen />
      </ThemeProvider>,
    );
    await waitFor(() => expect(useSession.getState().status).toBe('signedIn'));
  });
});
