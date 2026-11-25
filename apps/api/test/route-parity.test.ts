import { ALL_ROUTES } from '@tonnage/mock-api';
import { afterAll, describe, expect, it } from 'vitest';
import { routeTable } from '../src/http/route.ts';
import { buildTestApp, closeTestApps } from './helpers.ts';

/** Plan Ruling 1: the 22 M1 routes. Push-token routes (F5) belong to B4. */
const M1_ROUTES = [
  'GET /v1/meta',
  'POST /v1/auth/request-code',
  'POST /v1/auth/verify',
  'POST /v1/auth/refresh',
  'POST /v1/auth/sign-out',
  'GET /v1/me',
  'PATCH /v1/me/preferences',
  'GET /v1/companies',
  'POST /v1/companies',
  'GET /v1/companies/:id',
  'PATCH /v1/companies/:id',
  'GET /v1/plants',
  'POST /v1/plants',
  'GET /v1/plants/:id',
  'PATCH /v1/plants/:id',
  'GET /v1/users',
  'POST /v1/users',
  'PATCH /v1/users/:id',
  'POST /v1/users/:id/deactivate',
  'POST /v1/users/:id/reactivate',
  'GET /v1/settings',
  'PATCH /v1/settings',
] as const;

/** B2 routes, added task by task (plan Ruling 1). */
const B2_ROUTES = ['GET /v1/parties', 'POST /v1/parties', 'GET /v1/parties/:id', 'PATCH /v1/parties/:id'] as const;

interface Shape {
  route: string;
  public: boolean;
  action: string | null;
  idempotent: boolean;
}

/** Both sides write path params as `:name`; any other notation is normalised to it. */
const normalise = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');

const shape = (r: {
  method: string;
  path: string;
  public?: boolean;
  action?: string;
  idempotent?: boolean;
}): Shape => ({
  route: `${r.method} ${normalise(r.path)}`,
  public: r.public === true,
  action: r.action ?? null,
  idempotent: r.idempotent === true,
});

const byRoute = (a: Shape, b: Shape) => a.route.localeCompare(b.route);

afterAll(closeTestApps);

describe('route parity with the mock (M1)', () => {
  it('the M1 list holds 22 distinct routes, every one of them in the mock', () => {
    expect(new Set(M1_ROUTES).size).toBe(22);
    const mock = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalise(r.pattern)}`));
    expect(M1_ROUTES.filter((r) => !mock.has(r))).toEqual([]);
  });

  it('every B2 route so far is in the mock', () => {
    const mock = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalise(r.pattern)}`));
    expect(B2_ROUTES.filter((r) => !mock.has(r))).toEqual([]);
  });

  it('the API registers exactly the M1 and B2 routes under /v1, with the same public, action and idempotent', async () => {
    const { app } = await buildTestApp();
    const wanted = new Set<string>([...M1_ROUTES, ...B2_ROUTES]);
    const mock = ALL_ROUTES.map((r) => shape({ ...r, path: r.pattern }))
      .filter((s) => wanted.has(s.route))
      .sort(byRoute);
    const api = routeTable(app)
      .filter((r) => r.url.startsWith('/v1/'))
      .map((r) => shape({ ...r, path: r.url }))
      .sort(byRoute);
    expect(api).toEqual(mock);
  });
});
