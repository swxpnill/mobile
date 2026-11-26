import { ROLES, can, type Role } from '@tonnage/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { routeTable, type RouteTableEntry } from '../src/http/route.ts';
import { buildTestApp, closeTestApps } from './helpers.ts';
import { buildWorld, idKindOf, pathFor, type World } from './support/world.ts';

/**
 * The permission matrix, generated: every role × every authenticated route the API registers,
 * expected from `policy.ts`'s `can()` and the plant scope, never from a hand-written list.
 * - `!can(role, action)` → 403 FORBIDDEN, whatever the ids or body.
 * - `can` with records in the role's scope → neither 403 nor 404 (a GET → 200). A route with a
 *   body gets `{}`, so most answer 422; writes that act anyway (a duplicate, a deactivation)
 *   rebuild the world before the next case.
 * - `can` with a record out of scope (another plant, another person's draft, another tenant) → 404,
 *   never 403. Only for routes without a body: the others check it (422) before the record.
 */
const t = await buildTestApp();
afterAll(closeTestApps);

const routes = routeTable(t.app).filter((r) => r.url.startsWith('/v1/'));
const authed = routes.filter((r): r is RouteTableEntry & { action: NonNullable<RouteTableEntry['action']> } => r.public !== true);
const name = (r: RouteTableEntry) => `${r.method} ${r.url}`;

let world: World | undefined;
let dirty = true;
beforeEach(async () => {
  if (!dirty && world) return;
  world = await buildWorld(t);
  dirty = false;
});
const w = () => {
  if (!world) throw new Error('world not built');
  return world;
};
const send = async (role: Role, r: RouteTableEntry, path: string) => {
  const body = r.body === true ? {} : undefined;
  const res = await w().call(role, r.method, path, body);
  if (r.method !== 'GET' && res.status >= 200 && res.status < 300) dirty = true;
  return res;
};
const code = (body: unknown) => (body as { code?: unknown } | null)?.code;

describe('policy matrix', () => {
  it('covers the 48 M1 + M2 routes: 5 public, every other one with an action', () => {
    expect(routes).toHaveLength(48);
    expect(routes.filter((r) => r.public === true).map(name).sort()).toEqual(
      ['GET /v1/meta', 'POST /v1/auth/refresh', 'POST /v1/auth/request-code', 'POST /v1/auth/sign-out', 'POST /v1/auth/verify'].sort(),
    );
    expect(authed.every((r) => r.action !== undefined)).toBe(true);
  });

  describe.each(ROLES.map((role) => ({ role })))('$role', ({ role }) => {
    it.each(authed.map((r) => ({ r, route: name(r) })))('$route in scope', async ({ r }) => {
      const path = pathFor(r.url, w().inScope(role));
      if (path === null) throw new Error(`no in-scope id for ${name(r)}`);
      const res = await send(role, r, path);
      const seen = `${res.status} ${JSON.stringify(res.body)}`;
      if (!can(role, r.action)) {
        expect({ status: res.status, code: code(res.body) }, seen).toEqual({ status: 403, code: 'FORBIDDEN' });
        return;
      }
      expect([401, 403, 404], seen).not.toContain(res.status);
      expect(res.status, seen).toBeLessThan(500);
      if (r.method === 'GET') expect(res.status, seen).toBe(200);
    });

    const scoped = authed.filter((r) => idKindOf(r.url) !== null && r.body !== true && can(role, r.action));
    it.each(scoped.map((r) => ({ r, route: name(r) })))('$route out of scope → 404', async ({ r }) => {
      const sets = [{ label: 'another tenant', ids: w().otherTenant }, { label: 'another plant or person', ids: w().otherScope(role) }];
      for (const { label, ids } of sets) {
        const path = pathFor(r.url, ids);
        if (path === null) continue;
        const res = await send(role, r, path);
        expect({ label, status: res.status, code: code(res.body) }, JSON.stringify(res.body)).toEqual({ label, status: 404, code: 'NOT_FOUND' });
      }
    });
  });
});
