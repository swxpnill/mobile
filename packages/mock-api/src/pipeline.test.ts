import { describe, expect, it } from 'vitest';
import { SAMPLE_WORLD } from '@tonnage/shared';
import { createFakeClock } from './clock.ts';
import { createMockApi } from './index.ts';
import { createPipeline } from './pipeline.ts';
import { buildRouter, route } from './router.ts';
import { issueTokens } from './sessions.ts';
import { createMemoryStorage, createStore } from './store.ts';

it('redacts money keys for plant roles (also on idempotent replay) and maps thrown errors to 500 INTERNAL', async () => {
  const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  const store = await createStore({ storage: createMemoryStorage(), storageKey: 'k', clock });
  const payload = { id: 'o1', qty: 5, rate: 100, nested: [{ amount: 3, x: 1 }] };
  const router = buildRouter([
    route('POST', '/v1/money', {
      action: 'self.view',
      idempotent: true,
      handler: async () => ({ body: payload }),
    }),
    route('GET', '/v1/boom', {
      action: 'self.view',
      handler: async () => {
        throw new Error('bug');
      },
    }),
  ]);
  const { handle } = createPipeline({ router, store, clock });
  const tok = (userId: string) => issueTokens(store.state, userId, 'd', clock.now()).accessToken;
  const post = (userId: string, key: string) =>
    handle({
      method: 'POST',
      path: '/v1/money',
      headers: { authorization: `Bearer ${tok(userId)}`, 'idempotency-key': key },
    });

  const sup = await post(SAMPLE_WORLD.ids.users.ravi, 'a');
  expect(sup.body).toEqual({ id: 'o1', qty: 5, nested: [{ x: 1 }] });
  expect((await post(SAMPLE_WORLD.ids.users.ravi, 'a')).body).toEqual({
    id: 'o1',
    qty: 5,
    nested: [{ x: 1 }],
  });
  expect((await post(SAMPLE_WORLD.ids.users.kiran, 'b')).body).toEqual({
    id: 'o1',
    qty: 5,
    nested: [{ x: 1 }],
  });
  expect((await post(SAMPLE_WORLD.ids.users.rajesh, 'c')).body).toEqual(payload);

  const boom = await handle({
    method: 'GET',
    path: '/v1/boom',
    headers: { authorization: `Bearer ${tok(SAMPLE_WORLD.ids.users.rajesh)}` },
  });
  expect(boom.status).toBe(500);
  expect(boom.body).toMatchObject({ code: 'INTERNAL' });
});

describe('pipeline order: auth → policy → validation', () => {
  const start = Date.UTC(2026, 10, 3, 4, 30);
  const badCompany = { code: 'lower', name: '' };

  it('no token + invalid body on a protected route → 401 UNAUTHENTICATED', async () => {
    const api = await createMockApi({ clock: createFakeClock(start) });
    const res = await api.transport.request({
      method: 'POST',
      path: '/v1/companies',
      headers: { 'idempotency-key': 'k' },
      body: badCompany,
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('supervisor + invalid body on an owner-only route → 403 FORBIDDEN', async () => {
    const api = await createMockApi({ clock: createFakeClock(start) });
    const pair = await api.controls.signInAs(SAMPLE_WORLD.ids.users.ravi, 'd');
    const res = await api.transport.request({
      method: 'POST',
      path: '/v1/companies',
      headers: { authorization: `Bearer ${pair.accessToken}`, 'idempotency-key': 'k' },
      body: badCompany,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('public route (request-code) with invalid body → 422 VALIDATION', async () => {
    const api = await createMockApi({ clock: createFakeClock(start) });
    const res = await api.transport.request({
      method: 'POST',
      path: '/v1/auth/request-code',
      headers: {},
      body: { mobile: '12' },
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'VALIDATION' });
  });
});

describe('transactional routes', () => {
  it('a refusal half-way through undoes every change; a non-transactional route keeps them', async () => {
    const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
    const store = await createStore({ storage: createMemoryStorage(), storageKey: 'k', clock });
    const touch = (s: typeof store.state) => {
      s.numberSeries.push({ tenantId: 't', key: 'order', fy: '2026-27', next: 2 });
      s.parties[0]!.name = 'Changed';
    };
    const router = buildRouter([
      route('POST', '/v1/tx', {
        action: 'self.view',
        transactional: true,
        handler: async ({ state }) => {
          touch(state);
          throw new Error('refused after writing');
        },
      }),
      route('POST', '/v1/plain', {
        action: 'self.view',
        handler: async ({ state }) => {
          touch(state);
          throw new Error('refused after writing');
        },
      }),
    ]);
    const { handle } = createPipeline({ router, store, clock });
    const auth = { authorization: `Bearer ${issueTokens(store.state, SAMPLE_WORLD.ids.users.rajesh, 'd', clock.now()).accessToken}` };
    const name = store.state.parties[0]!.name;

    expect((await handle({ method: 'POST', path: '/v1/tx', headers: auth })).status).toBe(500);
    expect(store.state.numberSeries).toEqual([]);
    expect(store.state.parties[0]!.name).toBe(name);

    expect((await handle({ method: 'POST', path: '/v1/plain', headers: auth })).status).toBe(500);
    expect(store.state.numberSeries).toHaveLength(1);
    expect(store.state.parties[0]!.name).toBe('Changed');
  });
});
