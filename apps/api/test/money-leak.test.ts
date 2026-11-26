import { MONEY_KEYS, SAMPLE_WORLD, can, type Role } from '@tonnage/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeTable, type RouteTableEntry } from '../src/http/route.ts';
import { buildTestApp, closeTestApps } from './helpers.ts';
import { buildWorld, pathFor, type World } from './support/world.ts';

/**
 * The serializer leak check: Kiran (plant head, Siltara) and Ravi (supervisor, Siltara) call every
 * GET route the API registers, with real ids in their scope (an order with a broker, rates, a
 * dispatched and a weighed truck, a rate edit, a quantity move and a short close in its history),
 * and no response may carry a `MONEY_KEYS` key at any depth. Home and the orders list are also
 * walked with their filters. The owner's answers must carry money, or the check proves nothing.
 */
const t = await buildTestApp();
afterAll(closeTestApps);

const gets = routeTable(t.app).filter((r) => r.method === 'GET' && r.url.startsWith('/v1/'));
const name = (r: RouteTableEntry) => `${r.method} ${r.url}`;

/** Every `MONEY_KEYS` key anywhere in a JSON value, with its path. */
function moneyPaths(v: unknown, at = '$', out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => moneyPaths(x, `${at}[${i}]`, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEYS.has(k)) out.push(`${at}.${k}`);
      moneyPaths(x, `${at}.${k}`, out);
    }
  }
  return out;
}

let world: World | undefined;
beforeAll(async () => {
  world = await buildWorld(t, { history: true });
});
const call = async (role: Role, r: RouteTableEntry) => {
  if (!world) throw new Error('world not built');
  const path = pathFor(r.url, world.inScope(role));
  if (path === null) throw new Error(`no id for ${name(r)}`);
  return world.call(role, 'GET', path);
};
const AIP = SAMPLE_WORLD.ids.companies.AIP;
/** Filtered reads: the unit switcher on Home and the orders list, a status tab, a search, aged. */
const FILTERED = [
  `/v1/home?companyId=${AIP}`,
  `/v1/orders?companyId=${AIP}`,
  '/v1/orders?status=partly_dispatched&q=Shubham',
  '/v1/orders?status=all&aged=false&sort=oldest&limit=5',
];
const allowed = (role: Role, r: RouteTableEntry) => r.public === true || (r.action !== undefined && can(role, r.action));

describe('money leak', () => {
  it('walks the GET routes of M1 and M2', () => {
    expect(gets.map(name)).toEqual(expect.arrayContaining(['GET /v1/home', 'GET /v1/orders', 'GET /v1/orders/:id', 'GET /v1/orders/:id/activity']));
  });

  describe.each([{ role: 'plant_head' as const }, { role: 'supervisor' as const }])('$role', ({ role }) => {
    it.each(gets.map((r) => ({ r, route: name(r) })))('$route carries no money key', async ({ r }) => {
      const res = await call(role, r);
      const seen = `${res.status} ${JSON.stringify(res.body)}`;
      expect(res.status, seen).toBe(allowed(role, r) ? 200 : 403);
      expect(moneyPaths(res.body), seen).toEqual([]);
    });

    it.each(FILTERED.map((path) => ({ path })))('GET $path carries no money key', async ({ path }) => {
      if (!world) throw new Error('world not built');
      const res = await world.call(role, 'GET', path);
      const seen = `${res.status} ${JSON.stringify(res.body)}`;
      expect(res.status, seen).toBe(role === 'plant_head' ? 200 : 403);
      expect(moneyPaths(res.body), seen).toEqual([]);
    });
  });

  it('the walked activity holds the edit and the short close (the move names a Borai sub-order, hidden from Kiran)', async () => {
    const r = gets.find((x) => x.url === '/v1/orders/:id/activity');
    if (!r) throw new Error('no activity route');
    const actions = async (role: Role) => ((await call(role, r)).body as { action: string }[]).map((e) => e.action);
    expect(await actions('owner')).toEqual(
      expect.arrayContaining(['order.created', 'order.edited', 'order.quantity_moved', 'order.short_closed']),
    );
    const kiran = await actions('plant_head');
    expect(kiran).toEqual(expect.arrayContaining(['order.created', 'order.edited', 'order.short_closed']));
    expect(kiran).not.toContain('order.quantity_moved');
  });

  it('the owner sees money on the routes a plant head reads', async () => {
    for (const url of ['/v1/home', '/v1/orders', '/v1/orders/:id']) {
      const r = gets.find((x) => x.url === url);
      if (!r) throw new Error(`no route ${url}`);
      const res = await call('owner', r);
      expect(res.status, url).toBe(200);
      expect(moneyPaths(res.body).length, url).toBeGreaterThan(0);
    }
    if (!world) throw new Error('world not built');
    for (const path of FILTERED) {
      const res = await world.call('owner', 'GET', path);
      expect(res.status, path).toBe(200);
      expect(moneyPaths(res.body).length, path).toBeGreaterThan(0);
    }
  });
});
