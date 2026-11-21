import { asc, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDb, withTenant, type Db } from '../src/db/client.ts';
import { companies, plants } from '../src/db/schema/index.ts';
import {
  buildTestApp,
  closeTestApps,
  ownerInsertCompany,
  ownerInsertTenant,
  ownerInsertUser,
  type TestApp,
} from './helpers.ts';

/** Drizzle wraps the driver error (`Failed query: ...`); the Postgres message is its `cause`. */
const pgError = (message: RegExp) => ({
  cause: expect.objectContaining({ message: expect.stringMatching(message) }),
});

let t: TestApp;
let db: Db;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  t = await buildTestApp();
  db = t.db;
});
afterAll(closeTestApps);

beforeEach(async () => {
  await t.reset();
  tenantA = await ownerInsertTenant(t.ownerDb, 'Tenant A');
  tenantB = await ownerInsertTenant(t.ownerDb, 'Tenant B');
});

describe('row-level security as tonnage_app', () => {
  it('Review Focus 4: app role without a tenant sees no rows', async () => {
    await ownerInsertCompany(t.ownerDb, tenantA, 'AIP');
    expect(await db.select().from(companies)).toEqual([]);
  });

  it('withTenant sees only its own rows', async () => {
    await ownerInsertCompany(t.ownerDb, tenantA, 'AIP');
    await ownerInsertCompany(t.ownerDb, tenantB, 'XYZ');
    const codesA = await withTenant(db, tenantA, (tx) =>
      tx.select({ code: companies.code }).from(companies).orderBy(asc(companies.code)),
    );
    expect(codesA.map((r) => r.code)).toEqual(['AIP']);
    const codesB = await withTenant(db, tenantB, (tx) =>
      tx.select({ code: companies.code }).from(companies),
    );
    expect(codesB.map((r) => r.code)).toEqual(['XYZ']);
  });

  it('cannot insert a row for another tenant', async () => {
    const now = new Date('2026-11-03T04:30:00Z');
    await expect(
      withTenant(db, tenantA, (tx) =>
        tx.insert(companies).values({
          id: '019a4b1e-0000-7000-8000-0000000000c1',
          tenantId: tenantB,
          code: 'BAD',
          name: 'Bad',
          orderPrefix: 'BAD',
          createdAt: now,
          updatedAt: now,
        }),
      ),
    ).rejects.toMatchObject(pgError(/row-level security/));
  });

  it('composite FK blocks a plant pointing at another tenant’s company', async () => {
    const companyB = await ownerInsertCompany(t.ownerDb, tenantB, 'XYZ');
    const now = new Date('2026-11-03T04:30:00Z');
    await expect(
      withTenant(db, tenantA, (tx) =>
        tx.insert(plants).values({
          id: '019a4b1e-0000-7000-8000-0000000000d1',
          tenantId: tenantA,
          companyId: companyB,
          name: 'Siltara',
          location: 'Raipur',
          createdAt: now,
          updatedAt: now,
        }),
      ),
    ).rejects.toMatchObject(pgError(/foreign key/));
  });

  it('tenant setting does not leak to the next transaction on the same connection', async () => {
    await ownerInsertCompany(t.ownerDb, tenantA, 'AIP');
    const single = createDb(inject('appDatabaseUrl'), { max: 1 });
    try {
      const inside = await withTenant(single.db, tenantA, (tx) => tx.select().from(companies));
      expect(inside).toHaveLength(1);
      expect(await single.db.select().from(companies)).toEqual([]);
    } finally {
      await single.close();
    }
  });

  it('auth_lookup_mobile finds users across tenants for login only', async () => {
    await ownerInsertUser(t.ownerDb, tenantA, { mobile: '9826100012', name: 'Rajesh' });
    await ownerInsertUser(t.ownerDb, tenantB, {
      mobile: '9826100012',
      name: 'Rajesh B',
      active: false,
    });
    await ownerInsertUser(t.ownerDb, tenantB, { mobile: '9826100099', name: 'Someone else' });
    const res = await db.$client.query<{ tenant_name: string; active: boolean }>(
      'select tenant_name, active from auth_lookup_mobile($1) order by tenant_name',
      ['9826100012'],
    );
    expect(res.rows).toEqual([
      { tenant_name: 'Tenant A', active: true },
      { tenant_name: 'Tenant B', active: false },
    ]);
    // The function is the only way across tenants: a direct read still sees nothing.
    expect(await db.execute(sql`select * from users`)).toMatchObject({ rows: [] });
  });

  it('tonnage_app cannot turn RLS off', async () => {
    await expect(
      db.$client.query('alter table companies disable row level security'),
    ).rejects.toThrow(/must be owner/);
  });
});
