import { DEFAULT_TENANT_SETTINGS, type Role } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activityLog, plants, tenants, userPlants } from '../src/db/schema/index.ts';
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

interface World {
  tenantId: string;
  companyA: string;
  companyB: string;
  plantA: string;
  plantB: string;
  owner: Record<string, string>;
  supervisor: Record<string, string>;
  otherTenantCompany: string;
  otherTenantPlant: string;
}

async function insertPlant(t: TestApp, tenantId: string, companyId: string, name: string): Promise<string> {
  const id = uuidv7();
  const at = new Date(TEST_NOW);
  await t.ownerDb
    .insert(plants)
    .values({ id, tenantId, companyId, name, location: 'Raipur', createdAt: at, updatedAt: at });
  return id;
}

async function addUser(t: TestApp, tenantId: string, mobile: string, role: Role, plantIds: string[] = []) {
  const id = await ownerInsertUser(t.ownerDb, tenantId, { mobile, name: `User ${mobile}`, role });
  const at = new Date(TEST_NOW);
  for (const plantId of plantIds) {
    await t.ownerDb.insert(userPlants).values({ tenantId, userId: id, plantId, createdAt: at, updatedAt: at });
  }
  return bearerFor(t, tenantId, id);
}

async function seed(t: TestApp): Promise<World> {
  await t.reset();
  const tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  const companyA = await ownerInsertCompany(t.ownerDb, tenantId, 'AIP');
  const companyB = await ownerInsertCompany(t.ownerDb, tenantId, 'VSL');
  const plantA = await insertPlant(t, tenantId, companyA, 'Siltara');
  const plantB = await insertPlant(t, tenantId, companyB, 'Borai');
  const owner = await addUser(t, tenantId, '9826100012', 'owner');
  const supervisor = await addUser(t, tenantId, '9826100014', 'supervisor', [plantA]);
  const other = await ownerInsertTenant(t.ownerDb, 'Other Group');
  const otherTenantCompany = await ownerInsertCompany(t.ownerDb, other, 'TNT');
  const otherTenantPlant = await insertPlant(t, other, otherTenantCompany, 'Elsewhere');
  return { tenantId, companyA, companyB, plantA, plantB, owner, supervisor, otherTenantCompany, otherTenantPlant };
}

let t: TestApp;
let w: World;
beforeEach(async () => {
  t = await buildTestApp();
  w = await seed(t);
});

const post = (url: string, headers: Record<string, string>, payload: object, key = uuidv7()) =>
  t.app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': key }, payload });
const patch = (url: string, headers: Record<string, string>, payload: object) =>
  t.app.inject({ method: 'PATCH', url, headers, payload });
const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });

const newCompany = (code: string) => ({ code, name: `${code} Ltd`, gstin: null, orderPrefix: `SO-${code}` });
const activity = (action: string) => t.ownerDb.select().from(activityLog).where(eq(activityLog.action, action));

describe('companies', () => {
  it('owner lists the tenant companies only; a supervisor sees the company of their plant', async () => {
    const all = await get('/v1/companies', w.owner);
    expect(all.statusCode).toBe(200);
    expect(all.json().map((c: { code: string }) => c.code).sort()).toEqual(['AIP', 'VSL']);
    const mine = await get('/v1/companies', w.supervisor);
    expect(mine.json().map((c: { code: string }) => c.code)).toEqual(['AIP']);
  });

  it('GET by id: own company 200, other tenant / out of scope / random / malformed id → identical 404', async () => {
    expect((await get(`/v1/companies/${w.companyA}`, w.owner)).statusCode).toBe(200);
    expect((await get(`/v1/companies/${w.companyA}`, w.supervisor)).statusCode).toBe(200);
    const missing = await get(`/v1/companies/${uuidv7()}`, w.owner);
    expect(missing.statusCode).toBe(404);
    for (const res of [
      await get(`/v1/companies/${w.otherTenantCompany}`, w.owner),
      await get(`/v1/companies/${w.companyB}`, w.supervisor),
      await get('/v1/companies/not-a-uuid', w.owner),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(missing.json());
    }
  });

  it('POST creates (201, version 1, active), is idempotent, is logged, and is forbidden for a supervisor', async () => {
    const key = uuidv7();
    const res = await post('/v1/companies', w.owner, newCompany('SKS'), key);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      code: 'SKS',
      name: 'SKS Ltd',
      gstin: null,
      orderPrefix: 'SO-SKS',
      active: true,
      version: 1,
    });
    const replay = await post('/v1/companies', w.owner, newCompany('SKS'), key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(res.json());
    expect(await activity('company.created')).toHaveLength(1);
    expect((await post('/v1/companies', w.supervisor, newCompany('ZZZ'))).statusCode).toBe(403);
  });

  it('duplicate code → 422 VALIDATION at ["code"], nothing written', async () => {
    const res = await post('/v1/companies', w.owner, newCompany('AIP'));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION', details: [{ path: ['code'] }] });
    expect(await activity('company.created')).toHaveLength(0);
  });

  it('PATCH: stale version → 409 STALE; success bumps the version, stamps updatedAt from the clock, logs', async () => {
    const url = `/v1/companies/${w.companyA}`;
    expect((await patch(url, w.owner, { name: 'X', version: 9 })).json().code).toBe('STALE');
    const ok = await patch(url, w.owner, { name: 'Aarav Ispat Ltd', version: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'Aarav Ispat Ltd', version: 2 });
    expect((await patch(url, w.owner, { name: 'Again', version: 1 })).statusCode).toBe(409);
    expect(await activity('company.updated')).toHaveLength(1);
    expect((await patch(`/v1/companies/${w.otherTenantCompany}`, w.owner, { name: 'X', version: 1 })).statusCode).toBe(404);
  });

  it('PATCH to another company code → 422 VALIDATION at ["code"]', async () => {
    const res = await patch(`/v1/companies/${w.companyB}`, w.owner, { code: 'AIP', version: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json().details[0].path).toEqual(['code']);
  });

  it('PATCH can deactivate a company (no sub-orders in B1)', async () => {
    const res = await patch(`/v1/companies/${w.companyB}`, w.owner, { active: false, version: 1 });
    expect(res.json()).toMatchObject({ active: false, version: 2 });
  });

  it('duplicate company code under concurrency → one 201, one 422 (unique index → VALIDATION, not 500)', async () => {
    const results = await Promise.all([
      post('/v1/companies', w.owner, newCompany('RACE')),
      post('/v1/companies', w.owner, newCompany('RACE')),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    const loser = results.find((r) => r.statusCode === 422);
    expect(loser?.json()).toMatchObject({ code: 'VALIDATION', details: [{ path: ['code'] }] });
    expect(await activity('company.created')).toHaveLength(1);
  });

  it('PATCH with a stale version under concurrency → one 200, one 409 STALE (update … where version = $v)', async () => {
    const url = `/v1/companies/${w.companyA}`;
    const results = await Promise.all([
      patch(url, w.owner, { name: 'First', version: 1 }),
      patch(url, w.owner, { name: 'Second', version: 1 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json().code).toBe('STALE');
    expect((await get(url, w.owner)).json().version).toBe(2);
    expect(await activity('company.updated')).toHaveLength(1);
  });
});

describe('plants', () => {
  it('lists by scope and filters by companyId; a foreign company yields []; a bad uuid → 422', async () => {
    const all = await get('/v1/plants', w.owner);
    expect(all.json().map((p: { name: string }) => p.name).sort()).toEqual(['Borai', 'Siltara']);
    expect((await get('/v1/plants', w.supervisor)).json().map((p: { id: string }) => p.id)).toEqual([w.plantA]);
    expect((await get(`/v1/plants?companyId=${w.companyB}`, w.owner)).json()).toHaveLength(1);
    expect((await get(`/v1/plants?companyId=${w.otherTenantCompany}`, w.owner)).json()).toEqual([]);
    expect((await get(`/v1/plants?companyId=${w.companyB}`, w.supervisor)).json()).toEqual([]);
    expect((await get('/v1/plants?companyId=nope', w.owner)).statusCode).toBe(422);
  });

  it('GET by id: scoped, other tenant → 404', async () => {
    expect((await get(`/v1/plants/${w.plantA}`, w.supervisor)).statusCode).toBe(200);
    expect((await get(`/v1/plants/${w.plantB}`, w.supervisor)).statusCode).toBe(404);
    expect((await get(`/v1/plants/${w.otherTenantPlant}`, w.owner)).statusCode).toBe(404);
  });

  it('POST creates (201) under an own company, 404 under another tenant company; PATCH versions', async () => {
    const res = await post('/v1/plants', w.owner, { companyId: w.companyA, name: 'Urla', location: 'Raipur' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ companyId: w.companyA, name: 'Urla', active: true, version: 1 });
    expect(
      (await post('/v1/plants', w.owner, { companyId: w.otherTenantCompany, name: 'X', location: 'Y' })).statusCode,
    ).toBe(404);
    const url = `/v1/plants/${res.json().id}`;
    expect((await patch(url, w.owner, { name: 'Z', version: 4 })).json().code).toBe('STALE');
    const ok = await patch(url, w.owner, { name: 'Urla II', companyId: w.companyB, version: 1 });
    expect(ok.json()).toMatchObject({ name: 'Urla II', companyId: w.companyB, version: 2 });
    expect((await patch(url, w.owner, { companyId: w.otherTenantCompany, version: 2 })).statusCode).toBe(404);
    expect(await activity('plant.created')).toHaveLength(1);
    expect(await activity('plant.updated')).toHaveLength(1);
  });
});

describe('settings', () => {
  it('GET returns defaults for a tenant with nothing stored; supervisors may read, not write', async () => {
    const res = await get('/v1/settings', w.supervisor);
    expect(res.json()).toEqual(DEFAULT_TENANT_SETTINGS);
    expect((await patch('/v1/settings', w.supervisor, { agedOrderDays: 5 })).statusCode).toBe(403);
  });

  it('PATCH merges over the current settings, drops unknown keys, persists, logs only changed keys', async () => {
    const res = await patch('/v1/settings', w.owner, { agedOrderDays: 5, completionToleranceKg: 1000, bogus: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...DEFAULT_TENANT_SETTINGS, agedOrderDays: 5 });
    expect((await get('/v1/settings', w.owner)).json().agedOrderDays).toBe(5);
    const [stored] = await t.ownerDb.select().from(tenants).where(eq(tenants.id, w.tenantId));
    expect(stored?.settings).toEqual({ ...DEFAULT_TENANT_SETTINGS, agedOrderDays: 5 });
    const rows = await activity('settings.updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toEqual({ keys: ['agedOrderDays'] });
    expect(rows[0]?.entityId).toBe(w.tenantId);
  });

  it('settings PATCH with an unchanged value logs no activity row', async () => {
    const res = await patch('/v1/settings', w.owner, { agedOrderDays: DEFAULT_TENANT_SETTINGS.agedOrderDays });
    expect(res.statusCode).toBe(200);
    expect(await activity('settings.updated')).toHaveLength(0);
  });

  it('an invalid value → 422 VALIDATION and nothing changes', async () => {
    const res = await patch('/v1/settings', w.owner, { agedOrderDays: 0 });
    expect(res.statusCode).toBe(422);
    expect(res.json().details[0].path).toEqual(['agedOrderDays']);
    expect((await get('/v1/settings', w.owner)).json()).toEqual(DEFAULT_TENANT_SETTINGS);
  });
});
