import { ROLES, can, type Role } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { routeTable, type RouteTableEntry } from '../src/http/route.ts';
import { buildTestApp, closeTestApps } from './helpers.ts';
import { buildWorld, idKindOf, pathFor, type IdKind, type World } from './support/world.ts';

/**
 * The permission matrix, generated: every role × every authenticated route the API registers,
 * expected from `policy.ts`'s `can()` and the plant scope, never from a hand-written list.
 * - `!can(role, action)` → 403 FORBIDDEN, whatever the ids or body.
 * - `can` with records in the role's scope → neither 403 nor 404 (a GET → 200). An `:id` route with
 *   a body gets a valid one (`World.bodies`, so also never 422); other body routes get `{}` and
 *   mostly answer 422. A write that acts (an edit, a delete, a duplicate) rebuilds the world before
 *   the next case.
 * - `can` with a record out of scope (another tenant, a random id, another plant, another person's
 *   draft) → 404, never 403, on every `:id` route, those with a body included (their valid body
 *   gets past the 422 check to the record lookup).
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
/** The route's valid body when the world has one, else `{}` for a body route, else none. */
const bodyOf = (r: RouteTableEntry): unknown => w().bodies[name(r)] ?? (r.body === true ? {} : undefined);
const send = async (role: Role, r: RouteTableEntry, path: string) => {
  const body = bodyOf(r);
  const res = await w().call(role, r.method, path, body);
  if (r.method !== 'GET' && res.status >= 200 && res.status < 300) dirty = true;
  return res;
};
const code = (body: unknown) => (body as { code?: unknown } | null)?.code;

describe('policy matrix', () => {
  it('covers the M1 + M2 routes and B3 so far: 5 public, every other one with an action', () => {
    expect(routes).toHaveLength(64);
    expect(routes.filter((r) => r.public === true).map(name).sort()).toEqual(
      ['GET /v1/meta', 'POST /v1/auth/refresh', 'POST /v1/auth/request-code', 'POST /v1/auth/sign-out', 'POST /v1/auth/verify'].sort(),
    );
    expect(authed.every((r) => r.action !== undefined)).toBe(true);
  });

  it('has a valid body for every `:id` route that takes one, and only for those', () => {
    const wanted = authed.filter((r) => r.body === true && idKindOf(r.url) !== null).map(name).sort();
    expect(Object.keys(w().bodies).sort()).toEqual(wanted);
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
      if (w().bodies[name(r)] !== undefined) expect(res.status, seen).not.toBe(422);
      expect(res.status, seen).toBeLessThan(500);
      if (r.method === 'GET') expect(res.status, seen).toBe(200);
    });

    const scoped = authed.filter((r) => idKindOf(r.url) !== null && can(role, r.action));
    it.each(scoped.map((r) => ({ r, route: name(r) })))('$route out of scope → 404', async ({ r }) => {
      const sets = [
        { label: 'another tenant', ids: w().otherTenant },
        { label: 'a random id', ids: randomIds() },
        { label: 'another plant or person', ids: w().otherScope(role) },
      ];
      for (const { label, ids } of sets) {
        const path = pathFor(r.url, ids);
        if (path === null) continue;
        const res = await send(role, r, path);
        expect({ label, status: res.status, code: code(res.body) }, JSON.stringify(res.body)).toEqual({ label, status: 404, code: 'NOT_FOUND' });
      }
    });
  });
});

/** A fresh, well-formed id that names nothing, for every kind. */
function randomIds(): Record<IdKind, string> {
  const id = uuidv7();
  return {
    companies: id,
    plants: id,
    users: id,
    parties: id,
    products: id,
    orders: id,
    drafts: id,
    'sub-orders': id,
    trucks: id,
    'weighment-rejections': id,
  };
}
