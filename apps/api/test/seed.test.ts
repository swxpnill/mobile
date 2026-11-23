import { SAMPLE_WORLD } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companies, plants, tenants, userPlants, users } from '../src/db/schema/index.ts';
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
});
