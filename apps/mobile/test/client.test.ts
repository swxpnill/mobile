import * as SecureStore from 'expo-secure-store';
import {
  type Transport,
  type TransportRequest,
  NetworkError,
  SAMPLE_WORLD,
  meSchema,
  plantSchema,
  tokenPairSchema,
} from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { ApiError, api, needsForceUpdate } from '../src/api/client';
import { useNetStatus } from '../src/api/netStatus';
import { createHttpTransport, setTransport } from '../src/api/transport';
import { REFRESH_KEY, DEVICE_KEY, resetSessionForTests, useSession } from '../src/auth/session';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let mock: MockApi;
let clock: ReturnType<typeof createFakeClock>;
let sent: TransportRequest[];

function spy(inner: Transport): Transport {
  return {
    request: (req) => {
      sent.push(req);
      return inner.request(req);
    },
  };
}

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

const of = (path: string) => sent.filter((r) => r.path === path);

beforeEach(async () => {
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  useNetStatus.setState({ waking: false, pending: 0 });
  clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  mock = await createMockApi({ clock });
  sent = [];
  setTransport(spy(mock.transport));
});

describe('api()', () => {
  it('two concurrent 401s trigger exactly one refresh, both retried with the new token', async () => {
    await signIn();
    const oldToken = useSession.getState().accessToken;
    clock.advance(15 * MIN); // access token expired
    const [a, b] = await Promise.all([
      api('/v1/me', { schema: meSchema }),
      api('/v1/me', { schema: meSchema }),
    ]);
    expect(a.name).toBe('Rajesh Agrawal');
    expect(b.id).toBe(SAMPLE_WORLD.ids.users.rajesh);
    expect(of('/v1/auth/refresh')).toHaveLength(1);
    const newToken = useSession.getState().accessToken;
    expect(newToken).not.toBe(oldToken);
    const retried = of('/v1/me')
      .slice(-2)
      .map((r) => r.headers.authorization);
    expect(retried).toEqual([`Bearer ${newToken}`, `Bearer ${newToken}`]);
  });

  it('idempotent POST sends the same Idempotency-Key on its retry', async () => {
    await signIn();
    clock.advance(15 * MIN);
    const plant = await api('/v1/plants', {
      method: 'POST',
      idempotent: true,
      body: {
        companyId: SAMPLE_WORLD.ids.companies.AIP,
        name: 'Mandir Hasaud',
        location: 'Raipur',
      },
      schema: plantSchema,
    });
    expect(plant.name).toBe('Mandir Hasaud');
    const posts = of('/v1/plants');
    expect(posts).toHaveLength(2); // 401, then the retry
    const keys = posts.map((r) => r.headers['idempotency-key']);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('error body maps to ApiError with code', async () => {
    await signIn();
    const err = await api(`/v1/companies/019a4c00-0fff-7000-8000-000000000999`).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('a 422 keeps its details for field errors', async () => {
    await signIn();
    const err = await api('/v1/me/preferences', {
      method: 'PATCH',
      body: { unitBasis: 'lb' },
    }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'VALIDATION' });
    expect((err as ApiError).details).toEqual([expect.objectContaining({ path: ['unitBasis'] })]);
  });

  it('refresh failure signs out and forgets the refresh token', async () => {
    await signIn();
    clock.advance(61 * DAY); // refresh token expired too
    const err = await api('/v1/me').catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(useSession.getState().status).toBe('signedOut');
    expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBeNull();
  });

  it('a network failure is a NetworkError and never signs the user out', async () => {
    await signIn();
    mock.controls.setOffline(true);
    await expect(api('/v1/me')).rejects.toBeInstanceOf(NetworkError);
    expect(useSession.getState().status).toBe('signedIn');
  });

  it('a refresh that fails on the network keeps the session (offline start)', async () => {
    await signIn();
    clock.advance(15 * MIN);
    mock.controls.setOffline(true);
    await expect(api('/v1/me')).rejects.toBeInstanceOf(NetworkError);
    expect(useSession.getState().status).toBe('signedIn');
    mock.controls.setOffline(false);
    expect((await api('/v1/me', { schema: meSchema })).name).toBe('Rajesh Agrawal');
  });

  it('sets "waking" after 5 s pending and clears it when the response arrives', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    setTransport({
      request: () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, headers: {}, body: { ok: true } });
        }),
    });
    const p = api('/v1/meta', { auth: false });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(useNetStatus.getState().waking).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(useNetStatus.getState().waking).toBe(true);
    release();
    await p;
    expect(useNetStatus.getState().waking).toBe(false);
    jest.useRealTimers();
  });

  it('gives up after 90 s with a NetworkError', async () => {
    jest.useFakeTimers();
    setTransport({ request: () => new Promise(() => {}) });
    const outcome = expect(api('/v1/meta', { auth: false })).rejects.toBeInstanceOf(NetworkError);
    await jest.advanceTimersByTimeAsync(90_000);
    await outcome;
    jest.useRealTimers();
  });
});

describe('session', () => {
  it('init: no stored refresh token → signedOut; device id created once and reused', async () => {
    await useSession.getState().init();
    expect(useSession.getState().status).toBe('signedOut');
    const id = await SecureStore.getItemAsync(DEVICE_KEY);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    resetSessionForTests();
    await useSession.getState().init();
    expect(useSession.getState().deviceId).toBe(id);
  });

  it('init: stored refresh token → refreshed and signedIn (cold start)', async () => {
    await signIn();
    resetSessionForTests(); // app killed: memory gone, SecureStore kept
    await useSession.getState().init();
    expect(useSession.getState().status).toBe('signedIn');
    expect((await api('/v1/me', { schema: meSchema })).name).toBe('Rajesh Agrawal');
  });

  it('signOut revokes the refresh token on the server and clears it locally', async () => {
    await signIn();
    const refreshToken = useSession.getState().refreshToken!;
    await useSession.getState().signOut();
    expect(useSession.getState().status).toBe('signedOut');
    expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBeNull();
    const reuse = await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/refresh',
      headers: {},
      body: { refreshToken, deviceId: useSession.getState().deviceId },
    });
    expect(reuse.status).toBe(401);
  });

  it('signOut still signs out locally when the server cannot be reached', async () => {
    await signIn();
    mock.controls.setOffline(true);
    await useSession.getState().signOut();
    expect(useSession.getState().status).toBe('signedOut');
  });
});

describe('needsForceUpdate', () => {
  it('compares versions numerically', () => {
    expect(needsForceUpdate('1.0.0', '1.0.1')).toBe(true);
    expect(needsForceUpdate('1.2.0', '1.10.0')).toBe(true); // numeric, not string, compare
    expect(needsForceUpdate('1.10.0', '1.2.0')).toBe(false);
    expect(needsForceUpdate('1.0.0', '1.0.0')).toBe(false);
    expect(needsForceUpdate('2.0', '1.9.9')).toBe(false);
  });

  it('never blocks on a malformed version', () => {
    expect(needsForceUpdate('1.0.0', 'abc')).toBe(false);
    expect(needsForceUpdate('', '1.0.0')).toBe(false);
  });
});

describe('http transport', () => {
  it('sends JSON, lower-cases response headers, 204 → null body', async () => {
    const fetchFn = jest.fn(async () => ({
      status: 200,
      headers: new Headers({ 'Idempotent-Replay': 'true', 'Content-Type': 'application/json' }),
      text: async () => '{"ok":true}',
    }));
    const t = createHttpTransport('https://api.example.com', fetchFn as unknown as typeof fetch);
    const res = await t.request({
      method: 'POST',
      path: '/v1/x',
      headers: { a: '1' },
      body: { b: 2 },
    });
    expect(res).toEqual({
      status: 200,
      headers: expect.objectContaining({ 'idempotent-replay': 'true' }),
      body: { ok: true },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/v1/x',
      expect.objectContaining({ method: 'POST', body: '{"b":2}' }),
    );

    const noContent = createHttpTransport('https://x', (async () => ({
      status: 204,
      headers: new Headers(),
      text: async () => '',
    })) as unknown as typeof fetch);
    expect(
      (await noContent.request({ method: 'POST', path: '/v1/auth/sign-out', headers: {} })).body,
    ).toBeNull();
  });

  it('a fetch rejection becomes NetworkError', async () => {
    const t = createHttpTransport('https://x', (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch);
    await expect(
      t.request({ method: 'GET', path: '/v1/meta', headers: {} }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
