import { createFakeClock, createMockApi, DEV_OTP_CODE } from '@tonnage/mock-api';
import { SAMPLE_WORLD, type HttpMethod, type Transport } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { seed } from '../../src/db/seed.ts';
import { fastifyTransport } from '../fastify-transport.ts';
import { bearerFor, buildTestApp, TEST_NOW, type TestApp } from '../helpers.ts';
import { ownerInsertTruck, type TruckInput } from './trucks.ts';

export type Person = keyof typeof SAMPLE_WORLD.ids.users;

export interface Res {
  status: number;
  body: unknown;
}

/** One backend (the in-process mock or the API on Postgres) seen through the same calls. */
export interface Side {
  name: 'mock' | 'api';
  call(method: HttpMethod, path: string, opts?: { as?: Person; body?: unknown; key?: string }): Promise<Res>;
  addTruck(input: TruckInput): Promise<string>;
}

export interface Parity {
  mock: Side;
  api: Side;
  /** Both sides read this one clock. */
  clock: ReturnType<typeof createFakeClock>;
  t: TestApp;
  /** Runs the same call on both sides, the mock first. */
  both(method: HttpMethod, path: (s: Side) => string, opts?: (s: Side) => { as?: Person; body?: unknown }): Promise<[Res, Res]>;
}

const person = (p: Person) => {
  const u = SAMPLE_WORLD.users.find((x) => x.id === SAMPLE_WORLD.ids.users[p]);
  if (!u) throw new Error(`no sample person ${p}`);
  return u;
};

async function send(transport: Transport, method: HttpMethod, path: string, token: string, body?: unknown, key?: string): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token !== '') headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key !== undefined) headers['idempotency-key'] = key;
  const res = await transport.request({ method, path, headers, body });
  return { status: res.status, body: res.body ?? null };
}

/** Writes get a fresh Idempotency-Key unless the caller passes one. */
const keyFor = (method: HttpMethod, key?: string) => key ?? (method === 'GET' ? undefined : uuidv7());

/**
 * The mock (seeded with SAMPLE_WORLD, as `createMockApi` always is) and the API (SAMPLE_WORLD's org
 * layer from `seed`), on one fake clock. Masters are created by each test through both sides (R3).
 */
export async function buildParity(start = TEST_NOW): Promise<Parity> {
  const clock = createFakeClock(start);
  const mockApi = await createMockApi({ clock });
  const t = await buildTestApp({ clock });
  await t.reset();
  await seed(t.ownerDb, clock);
  const apiTransport = fastifyTransport(t.app);

  // The mock's access tokens last 15 minutes of its clock: sign in again once one is 10 minutes old.
  const mockTokens = new Map<Person, { token: string; at: number }>();
  const mockToken = async (p: Person): Promise<string> => {
    const cached = mockTokens.get(p);
    if (cached && clock.now() - cached.at < 10 * 60_000) return cached.token;
    const mobile = person(p).mobile;
    const none = '';
    const req = await send(mockApi.transport, 'POST', '/v1/auth/request-code', none, { mobile });
    if (req.status !== 200) throw new Error(`mock request-code: ${JSON.stringify(req.body)}`);
    const res = await send(mockApi.transport, 'POST', '/v1/auth/verify', none, {
      mobile,
      code: DEV_OTP_CODE,
      deviceId: uuidv7(),
    });
    if (res.status !== 200) throw new Error(`mock verify: ${JSON.stringify(res.body)}`);
    const token = (res.body as { accessToken: string }).accessToken;
    mockTokens.set(p, { token, at: clock.now() });
    return token;
  };
  const apiToken = async (p: Person): Promise<string> => {
    const { authorization } = await bearerFor(t, SAMPLE_WORLD.tenant.id, person(p).id);
    return (authorization ?? '').replace(/^Bearer /, '');
  };

  const mock: Side = {
    name: 'mock',
    call: async (method, path, opts = {}) =>
      send(mockApi.transport, method, path, await mockToken(opts.as ?? 'rajesh'), opts.body, keyFor(method, opts.key)),
    addTruck: async (input) => (await mockApi.fixtures.addTruck(input)).truckId,
  };
  const api: Side = {
    name: 'api',
    call: async (method, path, opts = {}) =>
      send(apiTransport, method, path, await apiToken(opts.as ?? 'rajesh'), opts.body, keyFor(method, opts.key)),
    addTruck: (input) => ownerInsertTruck(t.ownerDb, input, clock.now()),
  };
  return {
    mock,
    api,
    clock,
    t,
    async both(method, path, opts) {
      const m = await mock.call(method, path(mock), opts?.(mock));
      const a = await api.call(method, path(api), opts?.(api));
      return [m, a];
    },
  };
}
