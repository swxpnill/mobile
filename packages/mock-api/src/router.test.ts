import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRouter, route, type RouteDef } from './router.ts';
import { createMockApi } from './index.ts';

const handler = async () => ({ body: { ok: true } });

describe('buildRouter', () => {
  it('throws when a route has neither action nor public', () => {
    expect(() => buildRouter([{ method: 'GET', pattern: '/v1/x', handler } as RouteDef])).toThrow(
      /must declare action/,
    );
  });

  it('throws on idempotent public routes and duplicate routes', () => {
    expect(() =>
      buildRouter([route('POST', '/v1/x', { public: true, idempotent: true, handler })]),
    ).toThrow(/idempotent/);
    const r = route('GET', '/v1/x', { public: true, handler });
    expect(() => buildRouter([r, r])).toThrow(/duplicate/i);
  });

  it('matches path params and parses query', () => {
    const router = buildRouter([
      route('GET', '/v1/plants', { action: 'self.view', handler }),
      route('GET', '/v1/plants/:id', { action: 'self.view', handler }),
      route('POST', '/v1/users/:id/deactivate', { action: 'users.manage', handler }),
    ]);
    const m = router.match('GET', '/v1/plants/abc-1?x=1&y=a%20b');
    expect(m?.route.pattern).toBe('/v1/plants/:id');
    expect(m?.params).toEqual({ id: 'abc-1' });
    expect(m?.query).toEqual({ x: '1', y: 'a b' });
    expect(router.match('GET', '/v1/plants')?.query).toEqual({});
    expect(router.match('POST', '/v1/users/u1/deactivate')?.params).toEqual({ id: 'u1' });
    expect(router.match('PATCH', '/v1/plants/abc')).toBeNull();
    expect(router.match('GET', '/v1/plants/a/b')).toBeNull();
    expect(router.match('GET', '/v1/nope')).toBeNull();
  });

  it('route() keeps schemas for the pipeline', () => {
    const body = z.object({ a: z.string() });
    const r = route('POST', '/v1/x', {
      action: 'self.view',
      body,
      handler: async (ctx) => ({ body: ctx.body.a }),
    });
    expect(r.body).toBe(body);
  });
});

describe('unknown route', () => {
  it('unknown route → 404 { code: "NOT_FOUND" }', async () => {
    const api = await createMockApi();
    const res = await api.transport.request({
      method: 'GET',
      path: '/v1/does-not-exist',
      headers: {},
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(typeof (res.body as { message: unknown }).message).toBe('string');
    const wrongMethod = await api.transport.request({
      method: 'DELETE',
      path: '/v1/me',
      headers: {},
    });
    expect(wrongMethod.status).toBe(404);
  });
});
