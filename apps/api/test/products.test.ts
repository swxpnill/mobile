import type { Product, Role } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client.ts';
import { loadProducts, productInUse } from '../src/services/products.ts';
import {
  bearerFor,
  buildTestApp,
  closeTestApps,
  ownerInsertCompany,
  ownerInsertProduct,
  ownerInsertTenant,
  ownerInsertUser,
  type TestApp,
} from './helpers.ts';
import { waitForLockWaiters } from './support/lockWait.ts';

afterEach(closeTestApps);

let t: TestApp;
let tenantId: string;
let ownerId: string;
let owner: Record<string, string>;
let otherOwner: Record<string, string>;
let aip: string;
let krm: string;
let nap: string;
let foreignCompany: string;

async function personOf(
  tenant: string,
  mobile: string,
  role: Role,
): Promise<{ id: string; h: Record<string, string> }> {
  const id = await ownerInsertUser(t.ownerDb, tenant, { mobile, name: `User ${mobile}`, role });
  return { id, h: await bearerFor(t, tenant, id) };
}

beforeEach(async () => {
  t = await buildTestApp();
  await t.reset();
  tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  ({ id: ownerId, h: owner } = await personOf(tenantId, '9826100012', 'owner'));
  aip = await ownerInsertCompany(t.ownerDb, tenantId, 'AIP');
  krm = await ownerInsertCompany(t.ownerDb, tenantId, 'KRM');
  nap = await ownerInsertCompany(t.ownerDb, tenantId, 'NAP');
  const other = await ownerInsertTenant(t.ownerDb, 'Other Group');
  otherOwner = (await personOf(other, '9000000001', 'owner')).h;
  foreignCompany = await ownerInsertCompany(t.ownerDb, other, 'OTH');
});

const post = (headers: Record<string, string>, payload: object, key = uuidv7()) =>
  t.app.inject({ method: 'POST', url: '/v1/products', headers: { ...headers, 'idempotency-key': key }, payload });
const patch = (id: string, headers: Record<string, string>, payload: object) =>
  t.app.inject({ method: 'PATCH', url: `/v1/products/${id}`, headers, payload });
const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });
const del = (id: string, headers: Record<string, string>) =>
  t.app.inject({ method: 'DELETE', url: `/v1/products/${id}`, headers });

const tmt12 = () => ({
  category: 'TMT',
  grade: 'Fe500D',
  sizeLabel: '12 mm',
  conversionPerMt: 1_500,
  standardLengths: [
    { value: 6, unit: 'm' },
    { value: 12, unit: 'm' },
  ],
  companyIds: [aip, krm],
});

async function create(body: object, headers = owner): Promise<Product> {
  const res = await post(headers, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Product>();
}

const editBody = (p: Product) => ({
  category: p.category,
  grade: p.grade,
  sizeLabel: p.sizeLabel,
  conversionPerMt: p.conversionPerMt,
  standardLengths: p.standardLengths,
  companyIds: p.companyIds,
  active: p.active,
  version: p.version,
});

const countRows = async (sql: string, params: unknown[] = []) =>
  (await t.ownerDb.$client.query<{ n: number }>(sql, params)).rows[0]?.n;

describe('products', () => {
  it('create linked to AIP and KRM → GET shows both companies, in the order sent', async () => {
    const created = await create({ ...tmt12(), companyIds: [krm, aip] });
    expect(created).toEqual({
      id: expect.any(String),
      category: 'TMT',
      grade: 'Fe500D',
      sizeLabel: '12 mm',
      displayName: 'TMT Fe500D · 12 mm',
      tag: 'TMT',
      conversionPerMt: 1_500,
      standardLengths: [
        { value: 6, unit: 'm' },
        { value: 12, unit: 'm' },
      ],
      companyIds: [krm, aip],
      active: true,
      version: 1,
    });
    const res = await get(`/v1/products/${created.id}`, owner);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
    expect(
      await countRows(
        `select count(*)::int as n from activity_log where action = 'product.created' and entity_id = $1`,
        [created.id],
      ),
    ).toBe(1);
  });

  it('repeated company ids are stored once', async () => {
    const p = await create({ ...tmt12(), companyIds: [aip, krm, aip] });
    expect(p.companyIds).toEqual([aip, krm]);
  });

  it('422 at companyIds for none, a company of another tenant, or an unknown id', async () => {
    for (const companyIds of [[], [foreignCompany], [aip, uuidv7()]]) {
      const res = await post(owner, { ...tmt12(), companyIds });
      expect(res.statusCode, JSON.stringify(companyIds)).toBe(422);
      expect(res.json().code).toBe('VALIDATION');
      expect(res.json().details[0].path).toEqual(['companyIds']);
    }
    expect((await post(owner, { ...tmt12(), companyIds: ['nope'] })).json().code).toBe('VALIDATION');
    expect(await countRows('select count(*)::int as n from products')).toBe(0);
  });

  it('422 at standardLengths.i for a repeated length', async () => {
    const dup = [
      { value: 6, unit: 'm' },
      { value: 6, unit: 'm' },
    ];
    const res = await post(owner, { ...tmt12(), standardLengths: dup });
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toContainEqual(expect.objectContaining({ path: ['standardLengths', 1] }));
  });

  it('the same display name in the tenant (any case) → 422 at sizeLabel; another tenant may reuse it', async () => {
    await create(tmt12());
    for (const dup of [tmt12(), { ...tmt12(), category: 'tmt', grade: 'FE500d', sizeLabel: '12 MM' }]) {
      const res = await post(owner, dup);
      expect(res.statusCode).toBe(422);
      expect(res.json().details).toEqual([{ path: ['sizeLabel'], message: 'This product already exists' }]);
    }
    expect((await post(owner, { ...tmt12(), sizeLabel: '16 mm' })).statusCode).toBe(201);
    expect((await post(otherOwner, { ...tmt12(), companyIds: [foreignCompany] })).statusCode).toBe(201);
  });

  it('an empty grade reads as category then size, and collides with the same text split differently', async () => {
    await create({ ...tmt12(), category: 'MS Billet', grade: '', sizeLabel: '100 × 100' });
    const res = await post(owner, { ...tmt12(), category: 'MS', grade: 'Billet', sizeLabel: '100 × 100' });
    expect(res.statusCode).toBe(422);
  });

  it('two racing creates of one name: one 201, one 422, one row', async () => {
    const [a, b] = await Promise.all([post(owner, tmt12()), post(owner, tmt12())]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    expect(await countRows('select count(*)::int as n from products')).toBe(1);
  });

  it('list: filters by category, company, active and name; sorted by category, grade, size (numeric)', async () => {
    await create({ ...tmt12(), sizeLabel: '16 mm', companyIds: [aip] });
    await create({ ...tmt12(), sizeLabel: '8 mm', companyIds: [nap] });
    await create({ ...tmt12(), sizeLabel: '12 mm' });
    const billet = await create({
      ...tmt12(),
      category: 'MS Billet',
      grade: '',
      sizeLabel: '100 × 100',
      companyIds: [krm],
    });
    await patch(billet.id, owner, { ...editBody(billet), active: false });
    const names = async (qs = '') =>
      (await get(`/v1/products${qs}`, owner)).json<Product[]>().map((p) => p.displayName);
    expect(await names()).toEqual([
      'MS Billet · 100 × 100',
      'TMT Fe500D · 8 mm',
      'TMT Fe500D · 12 mm',
      'TMT Fe500D · 16 mm',
    ]);
    expect(await names('?category=tmt')).toEqual(['TMT Fe500D · 8 mm', 'TMT Fe500D · 12 mm', 'TMT Fe500D · 16 mm']);
    expect(await names(`?companyId=${nap}`)).toEqual(['TMT Fe500D · 8 mm']);
    expect(await names('?active=false')).toEqual(['MS Billet · 100 × 100']);
    expect(await names('?active=true&q=%2012')).toEqual(['TMT Fe500D · 12 mm']);
    expect(await names('?q=fe500d')).toHaveLength(3);
    expect((await get('/v1/products', otherOwner)).json()).toEqual([]);
  });

  it('PATCH replaces the fields and companies, bumps the version and logs it', async () => {
    const p = await create(tmt12());
    const res = await patch(p.id, owner, {
      ...editBody(p),
      conversionPerMt: 1_600,
      standardLengths: [],
      companyIds: [nap, aip],
      active: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      ...p,
      conversionPerMt: 1_600,
      standardLengths: [],
      companyIds: [nap, aip],
      active: false,
      version: 2,
    });
    expect((await get(`/v1/products/${p.id}`, owner)).json()).toEqual(res.json());
    expect(await countRows(`select count(*)::int as n from product_companies where product_id = $1`, [p.id])).toBe(2);
    expect(
      await countRows(
        `select count(*)::int as n from activity_log where action = 'product.updated' and entity_id = $1`,
        [p.id],
      ),
    ).toBe(1);
  });

  it("PATCH can keep its own name and refuses another product's", async () => {
    const p = await create(tmt12());
    const other = await create({ ...tmt12(), sizeLabel: '16 mm' });
    expect((await patch(p.id, owner, editBody(p))).statusCode).toBe(200);
    const res = await patch(other.id, owner, { ...editBody(other), sizeLabel: '12 mm' });
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toEqual([{ path: ['sizeLabel'], message: 'This product already exists' }]);
  });

  it('PATCH with a stale version → 409 STALE and nothing changes', async () => {
    const p = await create(tmt12());
    expect((await patch(p.id, owner, editBody(p))).statusCode).toBe(200);
    const res = await patch(p.id, owner, { ...editBody(p), conversionPerMt: 9 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STALE');
    expect((await get(`/v1/products/${p.id}`, owner)).json<Product>().conversionPerMt).toBe(1_500);
  });

  it('two PATCHes with the same version queued on a row lock: one 200, one 409 STALE', async () => {
    const p = await create(tmt12());
    const client = await t.ownerDb.$client.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from products where id = $1 for update', [p.id]);
      const a = patch(p.id, owner, { ...editBody(p), conversionPerMt: 1 });
      const b = patch(p.id, owner, { ...editBody(p), conversionPerMt: 2 });
      await waitForLockWaiters(t.ownerDb, 2);
      await client.query('commit');
      const codes = (await Promise.all([a, b])).map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);
    } finally {
      client.release();
    }
  });

  it('PATCH validates companies like create (422 at companyIds)', async () => {
    const p = await create(tmt12());
    const res = await patch(p.id, owner, { ...editBody(p), companyIds: [foreignCompany] });
    expect(res.statusCode).toBe(422);
    expect(res.json().details[0].path).toEqual(['companyIds']);
  });

  it('DELETE an unused product → 204, then GET → 404; links go with it', async () => {
    const p = await create(tmt12());
    const res = await del(p.id, owner);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await get(`/v1/products/${p.id}`, owner)).statusCode).toBe(404);
    expect(await countRows('select count(*)::int as n from product_companies')).toBe(0);
    expect(
      await countRows(
        `select count(*)::int as n from activity_log where action = 'product.deleted' and entity_id = $1`,
        [p.id],
      ),
    ).toBe(1);
    expect((await del(p.id, owner)).statusCode).toBe(404);
  });

  it('productInUse is false until order lines exist (Task 4 wires the real check and its 409 PRODUCT_IN_USE test)', async () => {
    const id = await ownerInsertProduct(t.ownerDb, tenantId, ownerId, [aip]);
    expect(await withTenant(t.db, tenantId, (tx) => productInUse(tx, id))).toBe(false);
  });

  it("another tenant's product, a random id or a malformed id → identical 404 on GET, PATCH and DELETE", async () => {
    const theirs = await create({ ...tmt12(), companyIds: [foreignCompany] }, otherOwner);
    const body = editBody(theirs);
    for (const id of [theirs.id, uuidv7(), 'not-a-uuid']) {
      const results = [await get(`/v1/products/${id}`, owner), await patch(id, owner, body), await del(id, owner)];
      for (const r of results) {
        expect(r.statusCode).toBe(404);
        expect(r.json().code).toBe('NOT_FOUND');
      }
    }
    expect((await get(`/v1/products/${theirs.id}`, otherOwner)).statusCode).toBe(200);
  });

  it('city staff may manage products; plant head and supervisor → 403 on every route', async () => {
    const p = await create(tmt12());
    const staff = (await personOf(tenantId, '9826100013', 'city_staff')).h;
    expect((await get('/v1/products', staff)).statusCode).toBe(200);
    for (const [mobile, role] of [
      ['9826100018', 'plant_head'],
      ['9826100014', 'supervisor'],
    ] as const) {
      const h = (await personOf(tenantId, mobile, role)).h;
      expect((await get('/v1/products', h)).statusCode).toBe(403);
      expect((await get(`/v1/products/${p.id}`, h)).statusCode).toBe(403);
      expect((await post(h, { ...tmt12(), sizeLabel: '20 mm' })).statusCode).toBe(403);
      expect((await patch(p.id, h, editBody(p))).statusCode).toBe(403);
      expect((await del(p.id, h)).statusCode).toBe(403);
    }
    expect((await get('/v1/products', {})).statusCode).toBe(401);
  });

  it('create is idempotent: a retry with the same key replays the product', async () => {
    const key = uuidv7();
    const a = await post(owner, tmt12(), key);
    const b = await post(owner, tmt12(), key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(await countRows('select count(*)::int as n from products')).toBe(1);
  });

  it('loadProducts returns each product with its companies in order; unknown ids are absent', async () => {
    const a = await ownerInsertProduct(t.ownerDb, tenantId, ownerId, [nap, aip], { sizeLabel: '8 mm' });
    const b = await ownerInsertProduct(t.ownerDb, tenantId, ownerId, [krm], { sizeLabel: '16 mm' });
    const found = await withTenant(t.db, tenantId, (tx) => loadProducts(tx, [b, a, uuidv7(), 'not-a-uuid']));
    expect([...found.keys()].sort()).toEqual([a, b].sort());
    expect(found.get(a)?.companyIds).toEqual([nap, aip]);
    expect(found.get(b)?.companyIds).toEqual([krm]);
    expect(found.get(a)?.sizeLabel).toBe('8 mm');
    expect(await withTenant(t.db, tenantId, (tx) => loadProducts(tx, []))).toEqual(new Map());
  });
});
