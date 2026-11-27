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

/** The 26 B2 routes (plan Ruling 1). */
const B2_ROUTES = [
  'GET /v1/parties',
  'POST /v1/parties',
  'GET /v1/parties/:id',
  'PATCH /v1/parties/:id',
  'GET /v1/products',
  'POST /v1/products',
  'GET /v1/products/:id',
  'PATCH /v1/products/:id',
  'DELETE /v1/products/:id',
  'POST /v1/orders',
  'GET /v1/orders',
  'GET /v1/orders/:id',
  'POST /v1/orders/:id/duplicate',
  'GET /v1/orders/drafts',
  'POST /v1/orders/drafts',
  'GET /v1/orders/drafts/:id',
  'PUT /v1/orders/drafts/:id',
  'DELETE /v1/orders/drafts/:id',
  'GET /v1/home',
  'PATCH /v1/orders/:id',
  'POST /v1/sub-orders/:id/short-close',
  'POST /v1/sub-orders/:id/reopen',
  'POST /v1/orders/:id/move-quantity',
  'GET /v1/orders/:id/delete-preview',
  'DELETE /v1/orders/:id',
  'GET /v1/orders/:id/activity',
] as const;

interface Shape {
  route: string;
  public: boolean;
  action: string | null;
  idempotent: boolean;
}

/** Both sides write path params as `:name`; any other notation is normalised to it. */
/** B3's routes so far (Ruling 1: 16 when B3 is done). */
const B3_ROUTES = [
  'GET /v1/trucks/recent-vehicles',
  'GET /v1/trucks/:id',
  'GET /v1/dispatch',
  'POST /v1/sub-orders/:id/trucks',
  'PATCH /v1/trucks/:id',
  'POST /v1/trucks/:id/cancel',
  'POST /v1/trucks/:id/approve',
  'POST /v1/weighments/sync',
];

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

describe('route parity with the mock (M1 + M2 + B3 so far)', () => {
  it('the M1 list holds 22 distinct routes, every one of them in the mock', () => {
    expect(new Set(M1_ROUTES).size).toBe(22);
    const mock = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalise(r.pattern)}`));
    expect(M1_ROUTES.filter((r) => !mock.has(r))).toEqual([]);
  });

  it('the B2 list holds 26 distinct routes, every one of them in the mock', () => {
    expect(new Set(B2_ROUTES).size).toBe(26);
    const mock = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalise(r.pattern)}`));
    expect(B2_ROUTES.filter((r) => !mock.has(r))).toEqual([]);
  });

  it('the B3 list is distinct, every one of them in the mock', () => {
    expect(new Set(B3_ROUTES).size).toBe(B3_ROUTES.length);
    const mock = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalise(r.pattern)}`));
    expect(B3_ROUTES.filter((r) => !mock.has(r))).toEqual([]);
  });

  it('the API registers exactly the M1, B2 and B3 routes under /v1, with the same public, action and idempotent', async () => {
    const { app } = await buildTestApp();
    const wanted = new Set<string>([...M1_ROUTES, ...B2_ROUTES, ...B3_ROUTES]);
    const mock = ALL_ROUTES.map((r) => shape({ ...r, path: r.pattern }))
      .filter((s) => wanted.has(s.route))
      .sort(byRoute);
    const api = routeTable(app)
      .filter((r) => r.url.startsWith('/v1/'))
      .map((r) => shape({ ...r, path: r.url }))
      .sort(byRoute);
    expect(api).toHaveLength(48 + B3_ROUTES.length);
    expect(api).toEqual(mock);
  });
});
