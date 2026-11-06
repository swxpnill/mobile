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
