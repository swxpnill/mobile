import { userSchema, meSchema } from '@tonnage/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokens } from '../src/auth/tokens.ts';
import { withTenant } from '../src/db/client.ts';
import { activityLog, plants, refreshTokens, userPlants, users } from '../src/db/schema/index.ts';
import {
  bearerFor,
  buildTestApp,
  closeTestApps,
  ownerInsertCompany,
  ownerInsertTenant,
  ownerInsertUser,
  testEnv,
  TEST_NOW,
  type TestApp,
} from './helpers.ts';

afterEach(closeTestApps);

type Auth = Record<string, string>;

interface World {
  tenantId: string;
  plantA: string;
  plantB: string;
  ownerId: string;
  owner2Id: string;
  staffId: string;
  supervisorId: string;
  owner: Auth;
  owner2: Auth;
  staff: Auth;
  supervisor: Auth;
  otherTenantPlant: string;
  otherTenantUser: string;
}

let t: TestApp;
let w: World;

async function addPlant(tenantId: string, companyId: string, name: string): Promise<string> {
  const id = uuidv7();
  const at = new Date(TEST_NOW);
  await t.ownerDb.insert(plants).values({ id, tenantId, companyId, name, location: 'Raipur', createdAt: at, updatedAt: at });
  return id;
}

async function seed(): Promise<World> {
  await t.reset();
  const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  const company = await ownerInsertCompany(t.ownerDb, tenantId, 'AIP');
  const plantA = await addPlant(tenantId, company, 'Siltara');
  const plantB = await addPlant(tenantId, company, 'Borai');
  const ownerId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '+919826100012', name: 'Rajesh', role: 'owner' });
  const owner2Id = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '+919826100020', name: 'Sunita', role: 'owner' });
  const staffId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '+919826100013', name: 'Priya', role: 'city_staff' });
  const supervisorId = await ownerInsertUser(t.ownerDb, tenantId, { mobile: '+919826100014', name: 'Ravi', role: 'supervisor' });
  const at = new Date(TEST_NOW);
  await t.ownerDb.insert(userPlants).values({ tenantId, userId: supervisorId, plantId: plantA, createdAt: at, updatedAt: at });
  // Everyone seeded so far has signed in, so they are "active", not "invited".
  await t.ownerDb.update(users).set({ lastSeenAt: at }).where(eq(users.tenantId, tenantId));
  const other = await ownerInsertTenant(t.ownerDb, 'Other Group');
  const otherCompany = await ownerInsertCompany(t.ownerDb, other, 'TNT');
  const otherTenantPlant = await addPlant(other, otherCompany, 'Elsewhere');
  const otherTenantUser = await ownerInsertUser(t.ownerDb, other, { mobile: '+919826100099', name: 'Foreign', role: 'owner' });
  return {
    tenantId,
    plantA,
    plantB,
    ownerId,
    owner2Id,
    staffId,
    supervisorId,
    owner: await bearerFor(t, tenantId, ownerId),
    owner2: await bearerFor(t, tenantId, owner2Id),
    staff: await bearerFor(t, tenantId, staffId),
    supervisor: await bearerFor(t, tenantId, supervisorId),
    otherTenantPlant,
    otherTenantUser,
  };
}

beforeEach(async () => {
  t = await buildTestApp();
  w = await seed();
});

const post = (url: string, headers: Auth, payload?: object, key = uuidv7()) =>
  t.app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
const patch = (url: string, headers: Auth, payload: object) => t.app.inject({ method: 'PATCH', url, headers, payload });
const get = (url: string, headers: Auth) => t.app.inject({ method: 'GET', url, headers });
const invite = (headers: Auth, body: object) => post('/v1/users', headers, body);
const activity = (action: string) => t.ownerDb.select().from(activityLog).where(eq(activityLog.action, action));
const plantsOf = async (userId: string) =>
  (await t.ownerDb.select().from(userPlants).where(eq(userPlants.userId, userId))).map((r) => r.plantId);

/** How many of the API's transactions are waiting on a lock (polled on the owner connection). */
async function waitForLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await t.ownerDb.$client.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where usename = 'tonnage_app' and wait_event_type = 'Lock'`,
    );
    if ((res.rows[0]?.n ?? 0) >= count) return;
    if (attempt > 2000) throw new Error(`only ${res.rows[0]?.n ?? 0} of ${count} requests reached a lock`);
  }
}

describe('invite', () => {
  it('201 with status invited, version 1, invited_at from the clock; logged; idempotent', async () => {
    const key = uuidv7();
    const body = { name: 'Naveen', mobile: '98261 00050', role: 'supervisor', plantIds: [w.plantB] };
    const res = await post('/v1/users', w.owner, body, key);
    expect(res.statusCode).toBe(201);
    const user = userSchema.parse(res.json());
    expect(user).toMatchObject({ mobile: '+919826100050', status: 'invited', active: true, plantIds: [w.plantB], version: 1 });
    const [row] = await t.ownerDb.select().from(users).where(eq(users.id, user.id));
    expect(row?.invitedAt.getTime()).toBe(TEST_NOW);
    expect(row?.lastSeenAt).toBeNull();
    expect(row?.preferences).toEqual({ unitBasis: 'mt' });
    expect(await plantsOf(user.id)).toEqual([w.plantB]);
    expect(await activity('user.invited')).toHaveLength(1);
    const replay = await post('/v1/users', w.owner, body, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(res.json());
  });

  it('PLANT_RULE with { role, min, max }; duplicate plant ids count once; unbounded max is null', async () => {
    const supervisor = (plantIds: string[]) => ({ name: 'S', mobile: '9826100051', role: 'supervisor', plantIds });
    const none = await invite(w.owner, supervisor([]));
    expect(none.statusCode).toBe(422);
    expect(none.json()).toMatchObject({ code: 'PLANT_RULE', details: { role: 'supervisor', min: 1, max: 1 } });
    expect((await invite(w.owner, supervisor([w.plantA, w.plantB]))).json().code).toBe('PLANT_RULE');
    // [a, a] is one plant: allowed for a supervisor.
    expect((await invite(w.owner, supervisor([w.plantA, w.plantA]))).statusCode).toBe(201);
    const head = await invite(w.owner, { name: 'H', mobile: '9826100052', role: 'plant_head', plantIds: [] });
    expect(head.json()).toMatchObject({ code: 'PLANT_RULE', details: { role: 'plant_head', min: 1, max: null } });
    const city = await invite(w.owner, { name: 'C', mobile: '9826100053', role: 'city_staff', plantIds: [w.plantA] });
    expect(city.json()).toMatchObject({ code: 'PLANT_RULE', details: { role: 'city_staff', min: 0, max: 0 } });
  });

  it('a plant of another tenant → 404', async () => {
    const res = await invite(w.owner, { name: 'F', mobile: '9826100054', role: 'supervisor', plantIds: [w.otherTenantPlant] });
    expect(res.statusCode).toBe(404);
  });

  it('a mobile already in the tenant (any typed shape) → 409 MOBILE_EXISTS', async () => {
    for (const mobile of ['09826100013', '9826100013', '+91 98261 00013']) {
      const res = await invite(w.owner, { name: 'P', mobile, role: 'city_staff', plantIds: [] });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MOBILE_EXISTS');
    }
  });

  it('only users.manage: city staff and supervisors → 403 on list and invite', async () => {
    for (const who of [w.staff, w.supervisor]) {
      expect((await get('/v1/users', who)).statusCode).toBe(403);
      expect((await invite(who, { name: 'X', mobile: '9826100056', role: 'city_staff', plantIds: [] })).statusCode).toBe(403);
    }
  });

  it('invite with a mobile already in the tenant under concurrency → one 201, one 409 MOBILE_EXISTS', async () => {
    // An uncommitted row with the mobile is held open on its own connection, so neither request can
    // see it in its existence check; both then wait on the unique index. Rolling it back lets one
    // insert win, and the other gets the unique violation, which must surface as MOBILE_EXISTS.
    const holder = await t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      await holder.query(
        `insert into users (id, tenant_id, name, mobile, role, invited_at, created_at, updated_at)
         values ($1, $2, 'Holder', '+919826100077', 'city_staff', now(), now(), now())`,
        [uuidv7(), w.tenantId],
      );
      const body = { name: 'Race', mobile: '9826100077', role: 'city_staff', plantIds: [] };
      const inFlight = [invite(w.owner, body), invite(w.owner, body)];
      await waitForLockWaiters(2);
      await holder.query('rollback');
      const results = await Promise.all(inFlight);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)?.json().code).toBe('MOBILE_EXISTS');
      const rows = await t.ownerDb
        .select()
        .from(users)
        .where(and(eq(users.tenantId, w.tenantId), eq(users.mobile, '+919826100077')));
      expect(rows).toHaveLength(1);
    } finally {
      holder.release();
    }
  });
});

describe('list and update', () => {
  it('lists the tenant users only, with statuses and plants', async () => {
    const at = new Date(TEST_NOW);
    const deepakId = uuidv7();
    await t.ownerDb
      .insert(users)
      .values({ id: deepakId, tenantId: w.tenantId, name: 'Deepak', mobile: '+919826100017', role: 'city_staff', invitedAt: at, createdAt: at, updatedAt: at });
    const res = await get('/v1/users', w.owner);
    expect(res.statusCode).toBe(200);
    const list = (res.json() as unknown[]).map((u) => userSchema.parse(u));
    expect(list).toHaveLength(5);
    expect(list.map((u) => u.id)).not.toContain(w.otherTenantUser);
    expect(list.find((u) => u.id === deepakId)?.status).toBe('invited');
    expect(list.find((u) => u.id === w.supervisorId)).toMatchObject({ status: 'active', plantIds: [w.plantA] });
  });

  it('changing role to city_staff deletes user_plants rows in the same transaction', async () => {
    const res = await patch(`/v1/users/${w.supervisorId}`, w.owner, { role: 'city_staff', version: 1 });
    expect(res.statusCode).toBe(200);
    expect(userSchema.parse(res.json())).toMatchObject({ role: 'city_staff', plantIds: [], version: 2 });
    expect(await plantsOf(w.supervisorId)).toEqual([]);
    const upd = await activity('user.updated');
    expect(upd).toHaveLength(1);
    expect(upd[0]?.meta).toEqual({ role: 'city_staff' });
  });

  it('a role change that breaks the plant rule → 422 and nothing changes', async () => {
    const res = await patch(`/v1/users/${w.supervisorId}`, w.owner, { role: 'plant_head', plantIds: [], version: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('PLANT_RULE');
    expect(await plantsOf(w.supervisorId)).toEqual([w.plantA]);
  });

  it('replaces plants, renames, bumps version; stale version → 409 STALE; foreign or malformed id → 404', async () => {
    const ok = await patch(`/v1/users/${w.supervisorId}`, w.owner, { name: 'Ravi K', plantIds: [w.plantB], version: 1 });
    expect(userSchema.parse(ok.json())).toMatchObject({ name: 'Ravi K', plantIds: [w.plantB], version: 2 });
    expect(await plantsOf(w.supervisorId)).toEqual([w.plantB]);
    const stale = await patch(`/v1/users/${w.supervisorId}`, w.owner, { name: 'X', version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('STALE');
    expect((await patch(`/v1/users/${w.otherTenantUser}`, w.owner, { name: 'X', version: 1 })).statusCode).toBe(404);
    expect((await patch('/v1/users/nope', w.owner, { name: 'X', version: 1 })).statusCode).toBe(404);
    expect((await patch(`/v1/users/${w.supervisorId}`, w.owner, { plantIds: [w.otherTenantPlant], version: 2 })).statusCode).toBe(404);
  });
});

describe('last owner', () => {
  it('the only active owner cannot deactivate or demote themselves; with a second owner both are allowed', async () => {
    await t.ownerDb.update(users).set({ active: false }).where(eq(users.id, w.owner2Id));
    const deact = await post(`/v1/users/${w.ownerId}/deactivate`, w.owner);
    expect(deact.statusCode).toBe(409);
    expect(deact.json().code).toBe('LAST_OWNER');
    const demote = await patch(`/v1/users/${w.ownerId}`, w.owner, { role: 'city_staff', version: 1 });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe('LAST_OWNER');
    await t.ownerDb.update(users).set({ active: true }).where(eq(users.id, w.owner2Id));
    expect((await patch(`/v1/users/${w.ownerId}`, w.owner, { role: 'city_staff', version: 1 })).statusCode).toBe(200);
  });

  it('Review Focus 2: the only two owners deactivate each other concurrently → one 200, one 409 LAST_OWNER; one active owner remains', async () => {
    // Hold one owner row so both requests queue on the owners lock in `assertNotLastOwner`.
    const holder = await t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      expect((await holder.query('select id from users where id = $1 for update', [w.ownerId])).rowCount).toBe(1);
      const inFlight = [
        post(`/v1/users/${w.owner2Id}/deactivate`, w.owner),
        post(`/v1/users/${w.ownerId}/deactivate`, w.owner2),
      ];
      await waitForLockWaiters(2);
      await holder.query('commit');
      const results = await Promise.all(inFlight);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)?.json().code).toBe('LAST_OWNER');
      const active = await t.ownerDb
        .select()
        .from(users)
        .where(and(eq(users.tenantId, w.tenantId), eq(users.role, 'owner'), eq(users.active, true)));
      expect(active).toHaveLength(1);
    } finally {
      holder.release();
    }
  });
});

describe('deactivate and reactivate', () => {
  it('deactivate revokes every refresh token, the next request is 401; reactivate restores; repeats are no-ops', async () => {
    const device = uuidv7();
    const tokens = createTokens(testEnv().JWT_SECRET);
    const pair = await withTenant(t.db, w.tenantId, (tx) =>
      tokens.issuePair(tx, { id: w.staffId, tenantId: w.tenantId }, device, TEST_NOW),
    );
    const off = await post(`/v1/users/${w.staffId}/deactivate`, w.owner);
    expect(off.statusCode).toBe(200);
    expect(userSchema.parse(off.json())).toMatchObject({ active: false, status: 'inactive', version: 2 });
    const live = await t.ownerDb
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, w.staffId), isNull(refreshTokens.revokedAt)));
    expect(live).toHaveLength(0);
    expect((await get('/v1/me', w.staff)).statusCode).toBe(401);

    const again = await post(`/v1/users/${w.staffId}/deactivate`, w.owner);
    expect(userSchema.parse(again.json()).version).toBe(2);
    expect(await activity('user.deactivated')).toHaveLength(1);

    const on = await post(`/v1/users/${w.staffId}/reactivate`, w.owner);
    expect(userSchema.parse(on.json())).toMatchObject({ active: true, status: 'active', version: 3 });
    expect((await get('/v1/me', w.staff)).statusCode).toBe(200);
    // Reactivated, so only the revocation can refuse this refresh (an inactive user is refused anyway).
    const refresh = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: pair.refreshToken, deviceId: device },
    });
    expect(refresh.statusCode).toBe(401);
    const on2 = await post(`/v1/users/${w.staffId}/reactivate`, w.owner);
    expect(userSchema.parse(on2.json()).version).toBe(3);
    expect(await activity('user.reactivated')).toHaveLength(1);
  });

  it('reactivate and a deactivate of the same user by another owner both complete (one lock order, no deadlock)', async () => {
    await t.ownerDb.update(users).set({ active: false }).where(eq(users.id, w.staffId));
    // The holder keeps the first owner's row locked FOR UPDATE. The deactivate queues for it first (holding
    // nothing of the target yet); the reactivate then locks the target and queues behind it. Released,
    // an implementation that lets the reactivate hold the target while the deactivate holds the owners
    // deadlocks (40P01 -> 500); with one lock order both finish.
    const holder = await t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      expect((await holder.query('select id from users where id = $1 for update', [w.ownerId])).rowCount).toBe(1);
      const deactivate = post(`/v1/users/${w.staffId}/deactivate`, w.owner2);
      await waitForLockWaiters(1);
      const reactivate = post(`/v1/users/${w.staffId}/reactivate`, w.owner);
      await waitForLockWaiters(2);
      await holder.query('commit');
      const results = await Promise.all([deactivate, reactivate]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    } finally {
      holder.release();
    }
  });

  it('unknown or foreign user → 404', async () => {
    for (const id of [uuidv7(), w.otherTenantUser, 'nope']) {
      expect((await post(`/v1/users/${id}/deactivate`, w.owner)).statusCode).toBe(404);
      expect((await post(`/v1/users/${id}/reactivate`, w.owner)).statusCode).toBe(404);
    }
  });
});

describe('/v1/me', () => {
  it('returns the caller with tenant and plants; preferences persist per user', async () => {
    const res = await get('/v1/me', w.supervisor);
    expect(meSchema.parse(res.json())).toEqual({
      id: w.supervisorId,
      name: 'Ravi',
      mobile: '+919826100014',
      role: 'supervisor',
      plantIds: [w.plantA],
      preferences: { unitBasis: 'mt' },
      tenant: { id: w.tenantId, name: 'Agrawal Group' },
    });
    const patched = await patch('/v1/me/preferences', w.supervisor, { unitBasis: 'kg' });
    expect(meSchema.parse(patched.json()).preferences).toEqual({ unitBasis: 'kg' });
    expect(meSchema.parse((await get('/v1/me', w.supervisor)).json()).preferences.unitBasis).toBe('kg');
    expect(meSchema.parse((await get('/v1/me', w.owner)).json()).preferences.unitBasis).toBe('mt');
    const bad = await patch('/v1/me/preferences', w.supervisor, { unitBasis: 'lb' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details[0].path).toEqual(['unitBasis']);
  });
});
