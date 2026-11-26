import type { ContractFixtures } from '@tonnage/contract-tests';
import { DEFAULT_TENANT_SETTINGS } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../src/clock.ts';
import type { Db } from '../src/db/client.ts';
import { companies, plants, tenants, users } from '../src/db/schema/index.ts';
import { ownerInsertTruck } from './support/trucks.ts';

/**
 * The contract's test-only hooks against Postgres (owner connection, bypassing RLS), mirroring the
 * mock's `fixtures.ts`: a second tenant with an owner who never signed in, company `TNT`, one plant.
 */
export function apiFixtures(ownerDb: Db, clock: Clock): ContractFixtures {
  return {
    async createTenant(name) {
      const at = new Date(clock.now());
      const stamps = { createdAt: at, updatedAt: at };
      const tenantId = uuidv7();
      const companyId = uuidv7();
      const plantId = uuidv7();
      return ownerDb.transaction(async (tx) => {
        // The mock's numbering: +917 and the tenant count, skipping numbers already taken.
        let n = (await tx.select({ id: tenants.id }).from(tenants)).length;
        let ownerMobile = '';
        for (;;) {
          ownerMobile = `+917${String(n).padStart(9, '0')}`;
          n += 1;
          const taken = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.mobile, ownerMobile));
          if (taken.length === 0) break;
        }
        await tx
          .insert(tenants)
          .values({ id: tenantId, name, settings: { ...DEFAULT_TENANT_SETTINGS }, ...stamps });
        await tx.insert(companies).values({
          id: companyId,
          tenantId,
          code: 'TNT',
          name: `${name} Steels`,
          gstin: null,
          orderPrefix: 'SO-TNT',
          active: true,
          version: 1,
          ...stamps,
        });
        await tx.insert(plants).values({
          id: plantId,
          tenantId,
          companyId,
          name: 'Main',
          location: 'Raipur',
          active: true,
          version: 1,
          ...stamps,
        });
        await tx.insert(users).values({
          id: uuidv7(),
          tenantId,
          name: `${name} Owner`,
          mobile: ownerMobile,
          role: 'owner',
          active: true,
          preferences: { unitBasis: 'mt' },
          invitedAt: at,
          lastSeenAt: null,
          version: 1,
          ...stamps,
        });
        return { tenantId, ownerMobile, companyId, plantId };
      });
    },
    // Plan Ruling 9: plain inserts (trucks, plan lines, allocations), no weighments.
    async addTruck(input) {
      return { truckId: await ownerInsertTruck(ownerDb, input, clock.now()) };
    },
  };
}
