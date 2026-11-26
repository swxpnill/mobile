import { SAMPLE_MASTERS, SAMPLE_WORLD } from '@tonnage/shared';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  companies,
  contactNumbers,
  parties,
  partyAddresses,
  partyContacts,
  plants,
  productCompanies,
  products,
  tenants,
  userPlants,
  users,
} from '../src/db/schema/index.ts';
import { seed } from '../src/db/seed.ts';
import { buildTestApp, closeTestApps, TEST_NOW, type TestApp } from './helpers.ts';

afterEach(closeTestApps);

describe('seed', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.reset();
  });

  it('inserts the sample world once, with the same ids, and is idempotent', async () => {
    const first = await seed(t.ownerDb, t.clock);
    const second = await seed(t.ownerDb, t.clock);
    expect(first.tenantId).toBe(SAMPLE_WORLD.tenant.id);
    expect(second.tenantId).toBe(SAMPLE_WORLD.tenant.id);

    const tenantRows = await t.ownerDb.select().from(tenants);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]?.name).toBe('Agrawal Group');
    expect(await t.ownerDb.select().from(companies)).toHaveLength(SAMPLE_WORLD.companies.length);
    expect(await t.ownerDb.select().from(plants)).toHaveLength(SAMPLE_WORLD.plants.length);
    const userRows = await t.ownerDb.select().from(users);
    expect(userRows).toHaveLength(SAMPLE_WORLD.users.length);
    expect(SAMPLE_WORLD.companies).toHaveLength(4);
    expect(SAMPLE_WORLD.plants).toHaveLength(4);
    expect(SAMPLE_WORLD.users).toHaveLength(8);
    expect(userRows.map((u) => u.id).sort()).toEqual(SAMPLE_WORLD.users.map((u) => u.id).sort());
    const expectedLinks = SAMPLE_WORLD.users.reduce((n, u) => n + u.plantIds.length, 0);
    expect(await t.ownerDb.select().from(userPlants)).toHaveLength(expectedLinks);
  });

  it('puts Ravi at Siltara, Deepak invited and everyone else active and seen now', async () => {
    await seed(t.ownerDb, t.clock);
    const siltara = SAMPLE_WORLD.plants.find((p) => p.name === 'Siltara');
    const ravi = SAMPLE_WORLD.users.find((u) => u.name === 'Ravi Verma');
    expect(siltara && ravi).toBeTruthy();
    const links = await t.ownerDb.select().from(userPlants).where(eq(userPlants.userId, ravi!.id));
    expect(links.map((l) => l.plantId)).toEqual([siltara!.id]);

    for (const row of await t.ownerDb.select().from(users)) {
      const sample = SAMPLE_WORLD.users.find((u) => u.id === row.id)!;
      expect(row.active).toBe(true);
      expect(row.version).toBe(1);
      expect(row.preferences).toEqual({ unitBasis: 'mt' });
      expect(row.invitedAt.getTime()).toBe(TEST_NOW);
      if (sample.name === 'Deepak Sahu') {
        expect(sample.status).toBe('invited');
        expect(row.lastSeenAt).toBeNull();
      } else {
        expect(sample.status).not.toBe('invited');
        expect(row.lastSeenAt?.getTime()).toBe(TEST_NOW);
      }
    }
  });

  it('inserts SAMPLE_MASTERS with the mock ids, children and company order, once', async () => {
    await seed(t.ownerDb, t.clock);
    await seed(t.ownerDb, t.clock);
    const m = SAMPLE_MASTERS;
    const partyRows = await t.ownerDb.select().from(parties).orderBy(asc(parties.id));
    expect(partyRows.map((p) => p.id)).toEqual(m.parties.map((p) => p.id).sort());
    expect(partyRows.every((p) => p.createdBy === SAMPLE_WORLD.ids.users.rajesh)).toBe(true);
    const contactCount = m.parties.reduce((n, p) => n + p.contacts.length, 0);
    const numberCount = m.parties.reduce((n, p) => n + p.contacts.reduce((k, c) => k + c.numbers.length, 0), 0);
    const addressCount = m.parties.reduce((n, p) => n + p.addresses.length, 0);
    expect(await t.ownerDb.select().from(partyContacts)).toHaveLength(contactCount);
    expect(await t.ownerDb.select().from(contactNumbers)).toHaveLength(numberCount);
    expect(await t.ownerDb.select().from(partyAddresses)).toHaveLength(addressCount);

    expect((await t.ownerDb.select().from(products)).map((p) => p.id).sort()).toEqual(m.products.map((p) => p.id).sort());
    const codeById = new Map(SAMPLE_WORLD.companies.map((c) => [c.id, c.code]));
    const links = await t.ownerDb
      .select()
      .from(productCompanies)
      .orderBy(asc(productCompanies.productId), asc(productCompanies.position));
    for (const p of m.products) {
      const codes = links.filter((l) => l.productId === p.id).map((l) => codeById.get(l.companyId));
      expect(codes, p.id).toEqual(p.companyCodes);
    }
  });

  it('adds the masters to a database seeded before them (org layer only)', async () => {
    await seed(t.ownerDb, t.clock);
    await t.ownerDb.$client.query('truncate parties, products cascade');
    await seed(t.ownerDb, t.clock);
    expect(await t.ownerDb.select().from(parties)).toHaveLength(SAMPLE_MASTERS.parties.length);
    expect(await t.ownerDb.select().from(products)).toHaveLength(SAMPLE_MASTERS.products.length);
    expect(await t.ownerDb.select().from(users)).toHaveLength(SAMPLE_WORLD.users.length);
  });
});
