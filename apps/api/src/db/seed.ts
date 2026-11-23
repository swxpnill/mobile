import { DEFAULT_TENANT_SETTINGS, SAMPLE_WORLD } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import type { Db } from './client.ts';
import { companies, plants, tenants, userPlants, users } from './schema/index.ts';

/**
 * Inserts the org layer of `SAMPLE_WORLD` (tenant, companies, plants, users, user plants) with the
 * fixture's ids, mirroring the mock's `seedState`. Needs the owner connection (RLS would refuse the
 * runtime role). One transaction; a no-op when the tenant already exists. Masters and orders: B2.
 */
export async function seed(ownerDb: Db, clock: Clock): Promise<{ tenantId: string }> {
  const w = SAMPLE_WORLD;
  const tenantId = w.tenant.id;
  const now = new Date(clock.now());
  const stamps = { createdAt: now, updatedAt: now };

  await ownerDb.transaction(async (tx) => {
    const existing = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (existing.length > 0) return;

    await tx.insert(tenants).values({
      id: tenantId,
      name: w.tenant.name,
      settings: { ...DEFAULT_TENANT_SETTINGS },
      ...stamps,
    });
    await tx.insert(companies).values(
      w.companies.map((c) => ({
        id: c.id,
        tenantId,
        code: c.code,
        name: c.name,
        gstin: c.gstin,
        orderPrefix: c.orderPrefix,
        active: true,
        version: 1,
        ...stamps,
      })),
    );
    await tx.insert(plants).values(
      w.plants.map((p) => ({
        id: p.id,
        tenantId,
        companyId: p.companyId,
        name: p.name,
        location: p.location,
        active: true,
        version: 1,
        ...stamps,
      })),
    );
    await tx.insert(users).values(
      w.users.map((u) => ({
        id: u.id,
        tenantId,
        name: u.name,
        mobile: u.mobile,
        role: u.role,
        active: true,
        version: 1,
        preferences: { unitBasis: 'mt' as const },
        invitedAt: now,
        lastSeenAt: u.status === 'invited' ? null : now,
        ...stamps,
      })),
    );
    const links = w.users.flatMap((u) =>
      u.plantIds.map((plantId) => ({ tenantId, userId: u.id, plantId, ...stamps })),
    );
    if (links.length > 0) await tx.insert(userPlants).values(links);
  });
  return { tenantId };
}
