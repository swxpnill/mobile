import { Writable } from 'node:stream';
import { createFakeClock } from '@tonnage/mock-api';
import { ERROR_MESSAGES, MONEY_KEYS, type Role } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityLog, companies, idempotencyKeys, plants, userPlants, users } from '../src/db/schema/index.ts';
import { AppError } from '../src/http/errors.ts';
import { defineRoute, routeTable, type RouteCtx } from '../src/http/route.ts';
import { logActivity } from '../src/services/activity.ts';
import {
  bearerFor,
  buildTestApp,
  closeTestApps,
  ownerInsertCompany,
  ownerInsertTenant,
  ownerInsertUser,
  TEST_NOW,
  type TestApp,
} from './helpers.ts';

afterEach(closeTestApps);

const DAY = 24 * 60 * 60 * 1000;

interface World {
  tenantId: string;
  ownerId: string;
  supervisorId: string;
  plantId: string;
}

async function seed(t: TestApp): Promise<World> {
  await t.reset();
  const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  const companyId = await ownerInsertCompany(t.ownerDb, tenantId, 'VSL');
  const plantId = uuidv7();
  const at = new Date(TEST_NOW);
  await t.ownerDb
    .insert(plants)
    .values({ id: plantId, tenantId, companyId, name: 'Siltara', location: 'Raipur', createdAt: at, updatedAt: at });
  const ownerId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '9826100012', name: 'Rajesh Agrawal' });
  const supervisorId = await ownerInsertUser(t.ownerDb, tenantId, {
    mobile: '9826100014',
    name: 'Ravi Verma',
    role: 'supervisor',
  });
  await t.ownerDb
    .insert(userPlants)
    .values({ tenantId, userId: supervisorId, plantId, createdAt: at, updatedAt: at });
  return { tenantId, ownerId, supervisorId, plantId };
}

async function bearer(t: TestApp, w: World, userId: string): Promise<Record<string, string>> {
  return bearerFor(t, w.tenantId, userId);
}

/** Every key of `value`, at any depth. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

const MONEY_PAYLOAD = {
  name: 'Order 1',
  valueRupees: 125_000,
  lines: [
    { kg: 10_000, rate: 52_000, nested: { amountRupees: 520, breakdown: { a: 1 }, note: 'kept' } },
    { kg: 5_000, rate: 51_000, nested: { due: 3, note: 'kept' } },
  ],
  broker: { name: 'R.K. Agarwal', earned: 100, payments: [{ paidOn: '2026-11-01', paid: 50 }] },
};

const insertCompany = (ctx: RouteCtx<unknown, unknown>, code: string) =>
  ctx.tx.insert(companies).values({
    id: uuidv7(),
    tenantId: ctx.user.tenantId,
    code,
    name: `${code} Ltd`,
    orderPrefix: code,
    createdAt: new Date(ctx.now),
    updatedAt: new Date(ctx.now),
  });

describe('defineRoute', () => {
  it('a route without action or public fails buildApp', async () => {
    const t = await buildTestApp();
    const handler = async () => ({});
    expect(() => defineRoute(t.app, 'GET', '/v1/test/bare', { handler } as never)).toThrow(
      'Route GET /v1/test/bare must declare action or public',
    );
    expect(() =>
      defineRoute(t.app, 'POST', '/v1/test/both', { public: true, idempotent: true, handler } as never),
    ).toThrow('Route POST /v1/test/both: public routes cannot be idempotent');
  });

  it('a route under /v1 registered without defineRoute fails at registration', async () => {
    const t = await buildTestApp();
    const register = async () => {
      t.app.get('/v1/test/raw', async () => ({ ok: true }));
      await t.app.ready();
    };
    await expect(register()).rejects.toThrow(
      'Route GET /v1/test/raw is under /v1 but was not registered with defineRoute',
    );
  });

  it('a route under /v1 registered in a prefixed plugin without defineRoute fails too', async () => {
    const t = await buildTestApp();
    await expect(
      t.app.register(
        async (child) => {
          child.post('/raw', async () => ({}));
        },
        { prefix: '/v1/test' },
      ),
    ).rejects.toThrow('Route POST /v1/test/raw is under /v1 but was not registered with defineRoute');
  });

  it('routes outside /v1 are not the pipeline’s concern', async () => {
    const t = await buildTestApp();
    t.app.get('/_t/outside', async () => ({ ok: true }));
    await t.app.ready();
    expect((await t.app.inject({ method: 'GET', url: '/_t/outside' })).json()).toEqual({ ok: true });
  });

  it('routeTable lists what defineRoute registered, prefixes included', async () => {
    const t = await buildTestApp();
    defineRoute(t.app, 'POST', '/v1/test/x', {
      action: 'companies.manage',
      idempotent: true,
      handler: async () => ({}),
    });
    const table = routeTable(t.app);
    expect(table).toContainEqual({ method: 'GET', url: '/v1/meta', public: true });
    expect(table).toContainEqual({ method: 'POST', url: '/v1/auth/verify', public: true });
    expect(table).toContainEqual({ method: 'POST', url: '/v1/test/x', action: 'companies.manage', idempotent: true });
    // Per app: another app does not see this one's throwaway route.
    const other = await buildTestApp();
    expect(routeTable(other.app).some((r) => r.url === '/v1/test/x')).toBe(false);
  });
});

describe('order of checks (Ruling 10)', () => {
  let t: TestApp;
  let w: World;
  beforeEach(async () => {
    t = await buildTestApp();
    w = await seed(t);
    defineRoute(t.app, 'POST', '/v1/test/ordered', {
      action: 'companies.manage',
      idempotent: true,
      body: z.object({ n: z.number().int() }),
      handler: async (ctx) => ({ status: 201, body: { n: ctx.body.n } }),
    });
  });

  it('no token, a forged token or an inactive user → 401 before the body is looked at', async () => {
    const bad = { method: 'POST' as const, url: '/v1/test/ordered', payload: { n: 'x' } };
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const res = await t.app.inject({ ...bad, headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'UNAUTHENTICATED', message: ERROR_MESSAGES.UNAUTHENTICATED });
    }
    const headers = await bearer(t, w, w.ownerId);
    await t.ownerDb.update(users).set({ active: false }).where(eq(users.id, w.ownerId));
    expect((await t.app.inject({ ...bad, headers })).statusCode).toBe(401);
  });

  it('a role without the action → 403 before the body; then 422, then 400 without a key', async () => {
    const ravi = await bearer(t, w, w.supervisorId);
    const forbidden = await t.app.inject({ method: 'POST', url: '/v1/test/ordered', headers: ravi, payload: { n: 'x' } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('FORBIDDEN');

    const owner = await bearer(t, w, w.ownerId);
    const invalid = await t.app.inject({ method: 'POST', url: '/v1/test/ordered', headers: owner, payload: { n: 'x' } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().details[0].path).toEqual(['n']);

    const keyless = await t.app.inject({ method: 'POST', url: '/v1/test/ordered', headers: owner, payload: { n: 1 } });
    expect(keyless.statusCode).toBe(400);
    expect(keyless.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('the handler gets the user and plant scope loaded from the database', async () => {
    let seen: Pick<RouteCtx<unknown, unknown>, 'user' | 'scope'> | undefined;
    defineRoute(t.app, 'GET', '/v1/test/whoami', {
      action: 'self.view',
      handler: async (ctx) => {
        seen = { user: ctx.user, scope: ctx.scope };
        return {};
      },
    });
    const res = await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: await bearer(t, w, w.supervisorId) });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({
      user: {
        id: w.supervisorId,
        tenantId: w.tenantId,
        tenantName: 'Agrawal Group',
        role: 'supervisor',
        plantIds: [w.plantId],
        name: 'Ravi Verma',
        mobile: '9826100014',
        preferences: { unitBasis: 'mt' },
      },
      scope: { kind: 'plants', plantIds: [w.plantId] },
    });
  });
});

describe('transaction', () => {
  it('a handler that throws rolls back its writes and its activity row', async () => {
    const t = await buildTestApp();
    const w = await seed(t);
    for (const [url, fail] of [
      ['/v1/test/write-ok', false],
      ['/v1/test/write-fail', true],
    ] as const) {
      defineRoute(t.app, 'POST', url, {
        action: 'companies.manage',
        handler: async (ctx) => {
          const code = fail ? 'FAIL' : 'OKAY';
          await insertCompany(ctx, code);
          await logActivity(ctx.tx, ctx.user, ctx.now, { entityType: 'company', entityId: uuidv7(), action: 'created', meta: { code } });
          if (fail) throw new AppError(409, 'STALE');
          return { status: 201, body: { code } };
        },
      });
    }
    const headers = await bearer(t, w, w.ownerId);
    const failed = await t.app.inject({ method: 'POST', url: '/v1/test/write-fail', headers });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toEqual({ code: 'STALE', message: ERROR_MESSAGES.STALE });
    expect((await t.app.inject({ method: 'POST', url: '/v1/test/write-ok', headers })).statusCode).toBe(201);

    const codes = (await t.ownerDb.select({ code: companies.code }).from(companies)).map((c) => c.code);
    expect(codes.sort()).toEqual(['OKAY', 'VSL']);
    const activity = await t.ownerDb.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      tenantId: w.tenantId,
      actorId: w.ownerId,
      entityType: 'company',
      action: 'created',
      meta: { code: 'OKAY' },
      orderId: null,
      at: new Date(TEST_NOW),
    });
  });

  it('a handler that returns a non-2xx rolls back too, and its body is still redacted', async () => {
    const t = await buildTestApp();
    const w = await seed(t);
    defineRoute(t.app, 'POST', '/v1/test/soft-fail', {
      action: 'weighment.capture',
      handler: async (ctx) => {
        await insertCompany(ctx, 'SOFT');
        return { status: 409, body: { reason: 'nope', amountRupees: 5 } };
      },
    });
    const res = await t.app.inject({ method: 'POST', url: '/v1/test/soft-fail', headers: await bearer(t, w, w.supervisorId) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ reason: 'nope' });
    expect(await t.ownerDb.select().from(companies).where(eq(companies.code, 'SOFT'))).toHaveLength(0);
  });
});

describe('redaction', () => {
  it('redaction: supervisor gets no money keys from a nested payload; owner untouched', async () => {
    const t = await buildTestApp();
    const w = await seed(t);
    defineRoute(t.app, 'GET', '/v1/test/money', { action: 'self.view', handler: async () => ({ body: MONEY_PAYLOAD }) });

    const sup = await t.app.inject({ method: 'GET', url: '/v1/test/money', headers: await bearer(t, w, w.supervisorId) });
    expect(sup.statusCode).toBe(200);
    expect(allKeys(sup.json()).filter((k) => MONEY_KEYS.has(k))).toEqual([]);
    expect(sup.json()).toEqual({
      name: 'Order 1',
      lines: [
        { kg: 10_000, nested: { note: 'kept' } },
        { kg: 5_000, nested: { note: 'kept' } },
      ],
      broker: { name: 'R.K. Agarwal', payments: [{ paidOn: '2026-11-01' }] },
    });

    const owner = await t.app.inject({ method: 'GET', url: '/v1/test/money', headers: await bearer(t, w, w.ownerId) });
    expect(owner.json()).toEqual(MONEY_PAYLOAD);
  });

  it('errors and public routes are never redacted', async () => {
    const t = await buildTestApp();
    defineRoute(t.app, 'GET', '/v1/test/public-money', { public: true, handler: async () => ({ body: { amountRupees: 7 } }) });
    const res = await t.app.inject({ method: 'GET', url: '/v1/test/public-money' });
    expect(res.json()).toEqual({ amountRupees: 7 });
  });
});

describe('idempotency', () => {
  let t: TestApp;
  let w: World;
  let runs: number;
  let failNext: boolean;
  beforeEach(async () => {
    t = await buildTestApp({ clock: createFakeClock(TEST_NOW) });
    w = await seed(t);
    runs = 0;
    failNext = false;
    defineRoute(t.app, 'POST', '/v1/test/idem', {
      action: 'companies.manage',
      idempotent: true,
      handler: async (ctx) => {
        runs += 1;
        await insertCompany(ctx, `C${runs}`);
        if (failNext) {
          failNext = false;
          throw new AppError(409, 'STALE');
        }
        return { status: 201, body: { run: runs, orderValue: 900 } };
      },
    });
    defineRoute(t.app, 'POST', '/v1/test/idem-capture', {
      action: 'weighment.capture',
      idempotent: true,
      handler: async () => {
        runs += 1;
        return { status: 201, body: { run: runs, earningRupees: 400, kg: 12_000 } };
      },
    });
    defineRoute(t.app, 'POST', '/v1/test/idem-other', {
      action: 'companies.manage',
      idempotent: true,
      handler: async () => ({ status: 201, body: {} }),
    });
  });

  const post = async (key: string, userId = w.ownerId, url = '/v1/test/idem') =>
    t.app.inject({ method: 'POST', url, headers: { ...(await bearer(t, w, userId)), 'idempotency-key': key } });
  const keyRows = () => t.ownerDb.select().from(idempotencyKeys);

  it('a replay returns the stored status and body with idempotent-replay: true; the handler runs once', async () => {
    const first = await post('k1');
    const replay = await post('k1');
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(runs).toBe(1);
    expect(await keyRows()).toMatchObject([
      { userId: w.ownerId, key: 'k1', route: 'POST /v1/test/idem', status: 201, body: { run: 1, orderValue: 900 } },
    ]);
  });

  it('an idempotent handler that fails leaves no key row; the retry runs the handler again', async () => {
    failNext = true;
    expect((await post('k2')).statusCode).toBe(409);
    expect(await keyRows()).toEqual([]);
    const retry = await post('k2');
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBeUndefined();
    expect(retry.json()).toEqual({ run: 2, orderValue: 900 });
    expect(runs).toBe(2);
  });

  it('a replay is redacted for the caller’s current role', async () => {
    expect((await post('k3')).json()).toEqual({ run: 1, orderValue: 900 });
    const demoted: Role = 'supervisor';
    await t.ownerDb.update(users).set({ role: demoted }).where(eq(users.id, w.ownerId));
    // A supervisor may not call this route at all, so the policy refuses before the replay.
    expect((await post('k3')).statusCode).toBe(403);

    // A route a supervisor may call, keyed by a body stored while they were owner.
    await t.ownerDb.update(users).set({ role: 'owner' }).where(eq(users.id, w.ownerId));
    const asOwner = await post('k4', w.ownerId, '/v1/test/idem-capture');
    expect(asOwner.json()).toEqual({ run: 2, earningRupees: 400, kg: 12_000 });
    await t.ownerDb.update(users).set({ role: demoted }).where(eq(users.id, w.ownerId));
    const replay = await post('k4', w.ownerId, '/v1/test/idem-capture');
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual({ run: 2, kg: 12_000 });
    expect(runs).toBe(2);
  });

  it('the same key on another route → 422 VALIDATION at idempotency-key', async () => {
    await post('k5');
    const res = await post('k5', w.ownerId, '/v1/test/idem-other');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      code: 'VALIDATION',
      message: ERROR_MESSAGES.VALIDATION,
      details: [{ path: ['idempotency-key'], message: 'This key was already used for another request' }],
    });
  });

  it('keys belong to the user', async () => {
    await t.ownerDb.update(users).set({ role: 'owner' }).where(eq(users.id, w.supervisorId));
    await post('k6');
    const other = await post('k6', w.supervisorId);
    expect(other.headers['idempotent-replay']).toBeUndefined();
    expect(runs).toBe(2);
  });

  it('keys older than 24 h by the clock are purged and the key can be reused', async () => {
    const clock = t.clock as ReturnType<typeof createFakeClock>;
    await post('k7');
    await post('old-other');
    clock.advance(DAY - 1);
    expect((await post('k7')).headers['idempotent-replay']).toBe('true');
    expect(runs).toBe(2);
    clock.advance(1);
    const fresh = await post('k7');
    expect(fresh.headers['idempotent-replay']).toBeUndefined();
    expect(fresh.json()).toEqual({ run: 3, orderValue: 900 });
    // The other expired key of this user went too; the reused key's row is the new one.
    expect(await keyRows()).toMatchObject([{ key: 'k7', body: { run: 3 }, createdAt: new Date(TEST_NOW + DAY) }]);
  });
});

describe('request log', () => {
  it('one completion line per request with reqId, tenantId, userId, route, status and ms; no headers', async () => {
    const lines: Record<string, unknown>[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
        cb();
      },
    });
    const t = await buildTestApp({ env: { LOG_LEVEL: 'info' }, logStream });
    const w = await seed(t);
    defineRoute(t.app, 'GET', '/v1/test/logged/:id', { action: 'self.view', handler: async () => ({}) });
    const headers = await bearer(t, w, w.ownerId);
    const res = await t.app.inject({ method: 'GET', url: '/v1/test/logged/abc', headers });
    await t.app.inject({ method: 'GET', url: '/v1/meta' });

    const done = lines.filter((l) => l.msg === 'request completed');
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({
      reqId: res.headers['x-request-id'],
      tenantId: w.tenantId,
      userId: w.ownerId,
      route: 'GET /v1/test/logged/:id',
      status: 200,
    });
    expect(typeof done[0]?.ms).toBe('number');
    expect(done[1]).toMatchObject({ tenantId: null, userId: null, route: 'GET /v1/meta', status: 200 });
    const all = JSON.stringify(lines);
    expect(all).not.toContain(headers.authorization?.slice(7));
    expect(lines.filter((l) => l.msg === 'incoming request')).toEqual([]);
  });
});

describe('responses are checked against their schema before commit', () => {
  let t: TestApp;
  let w: World;
  beforeEach(async () => {
    t = await buildTestApp();
    w = await seed(t);
    defineRoute(t.app, 'POST', '/v1/test/bad-shape', {
      action: 'companies.manage',
      idempotent: true,
      response: { 201: z.object({ id: z.string() }) },
      handler: async (ctx) => {
        await insertCompany(ctx, 'SHAPE');
        return { status: 201, body: { id: 5 } };
      },
    });
    defineRoute(t.app, 'POST', '/v1/test/money-required', {
      action: 'weighment.capture',
      idempotent: true,
      response: { 201: z.object({ kg: z.number(), amountRupees: z.number() }) },
      handler: async (ctx) => {
        await insertCompany(ctx, `M${ctx.user.role.length}`);
        return { status: 201, body: { kg: 1, amountRupees: 2 } };
      },
    });
  });

  const post = async (url: string, userId: string, key: string) =>
    t.app.inject({ method: 'POST', url, headers: { ...(await bearer(t, w, userId)), 'idempotency-key': key } });
  const companyCodes = async () => (await t.ownerDb.select({ code: companies.code }).from(companies)).map((c) => c.code);

  it('a write whose response fails its schema → 500, the write and the key row rolled back', async () => {
    const res = await post('/v1/test/bad-shape', w.ownerId, 'shape-1');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL });
    expect(await companyCodes()).toEqual(['VSL']);
    expect(await t.ownerDb.select().from(idempotencyKeys)).toEqual([]);
  });

  it('the redacted view is what is checked: a schema needing a money key fails for a supervisor, nothing committed', async () => {
    const sup = await post('/v1/test/money-required', w.supervisorId, 'money-1');
    expect(sup.statusCode).toBe(500);
    expect(await companyCodes()).toEqual(['VSL']);
    expect(await t.ownerDb.select().from(idempotencyKeys)).toEqual([]);

    // Control: the owner's unredacted view passes and commits.
    const owner = await post('/v1/test/money-required', w.ownerId, 'money-2');
    expect(owner.statusCode).toBe(201);
    expect((await companyCodes()).sort()).toEqual(['M5', 'VSL']);
  });

  it('a replay is checked too, for the caller’s current role', async () => {
    expect((await post('/v1/test/money-required', w.ownerId, 'money-3')).statusCode).toBe(201);
    await t.ownerDb.update(users).set({ role: 'supervisor' }).where(eq(users.id, w.ownerId));
    const replay = await post('/v1/test/money-required', w.ownerId, 'money-3');
    expect(replay.statusCode).toBe(500);
    // The stored result is untouched: the read-only replay check changes nothing.
    expect(await t.ownerDb.select().from(idempotencyKeys)).toHaveLength(1);
  });
});

describe('body parse errors come after auth and policy (Ruling 10)', () => {
  let t: TestApp;
  let w: World;
  let runs: number;
  beforeEach(async () => {
    t = await buildTestApp();
    w = await seed(t);
    runs = 0;
    defineRoute(t.app, 'POST', '/v1/test/manage-users', {
      action: 'users.manage',
      body: z.object({ name: z.string() }),
      handler: async (ctx) => {
        runs += 1;
        return { body: { name: ctx.body.name } };
      },
    });
    defineRoute(t.app, 'POST', '/v1/test/public-body', {
      public: true,
      body: z.object({ name: z.string() }),
      handler: async ({ body }) => ({ body }),
    });
  });

  const malformed = (headers: Record<string, string>, url = '/v1/test/manage-users') =>
    t.app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: '{"name": ' });

  it('a valid token of a deactivated user + malformed JSON → 401', async () => {
    const headers = await bearer(t, w, w.ownerId);
    await t.ownerDb.update(users).set({ active: false }).where(eq(users.id, w.ownerId));
    const res = await malformed(headers);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('a supervisor + malformed JSON or an unsupported content type on a users.manage route → 403', async () => {
    const headers = await bearer(t, w, w.supervisorId);
    expect((await malformed(headers)).statusCode).toBe(403);
    const xml = await t.app.inject({
      method: 'POST',
      url: '/v1/test/manage-users',
      headers: { ...headers, 'content-type': 'application/xml' },
      payload: '<name/>',
    });
    expect(xml.statusCode).toBe(403);
  });

  it('the owner + malformed JSON or an unsupported content type → 422 VALIDATION; the handler never runs', async () => {
    const headers = await bearer(t, w, w.ownerId);
    const res = await malformed(headers);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      code: 'VALIDATION',
      message: ERROR_MESSAGES.VALIDATION,
      details: [{ path: [], message: 'Body is not valid JSON' }],
    });
    const xml = await t.app.inject({
      method: 'POST',
      url: '/v1/test/manage-users',
      headers: { ...headers, 'content-type': 'application/xml' },
      payload: '<name/>',
    });
    expect(xml.statusCode).toBe(422);
    expect(xml.json().details).toEqual([{ path: [], message: 'Unsupported content type' }]);
    expect(runs).toBe(0);
  });

  it('an empty JSON body is no body: the schema reports it, and valid JSON still works', async () => {
    const headers = await bearer(t, w, w.ownerId);
    const empty = await t.app.inject({
      method: 'POST',
      url: '/v1/test/manage-users',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().details[0].path).toEqual([]);
    const ok = await t.app.inject({ method: 'POST', url: '/v1/test/manage-users', headers, payload: { name: 'A' } });
    expect(ok.json()).toEqual({ name: 'A' });
  });

  it('a public route still answers malformed JSON with 422 VALIDATION', async () => {
    const res = await malformed({}, '/v1/test/public-body');
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toEqual([{ path: [], message: 'Body is not valid JSON' }]);
  });

  it('JSON prototype poisoning is still refused', async () => {
    const headers = await bearer(t, w, w.ownerId);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/test/manage-users',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{"name":"A","__proto__":{"x":1}}',
    });
    expect(res.statusCode).toBe(422);
    expect(runs).toBe(0);
  });
});
