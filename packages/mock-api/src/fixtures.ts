import { DEFAULT_TENANT_SETTINGS } from '@tonnage/shared';
import { type Clock, toIso } from './clock.ts';
import type { Enqueue } from './controls.ts';
import type { Store } from './store.ts';
import { type AddTruckInput, addTruck } from './trucks.ts';
import { newId } from './views.ts';

export interface MockFixtures {
  /** A second tenant (owner never signed in, one company `TNT`, one plant) for cross-tenant cases. */
  createTenant(
    name: string,
  ): Promise<{ tenantId: string; ownerMobile: string; companyId: string; plantId: string }>;
  /** A truck in any state on an existing sub-order (dispatched ones carry allocations). */
  addTruck(input: AddTruckInput): Promise<{ truckId: string }>;
}

export function createFixtures(deps: {
  store: Store;
  clock: Clock;
  enqueue: Enqueue;
}): MockFixtures {
  const { store, clock, enqueue } = deps;
  return {
    addTruck: (input) =>
      enqueue(async () => {
        const truckId = addTruck(store.state, input, clock.now());
        store.schedulePersist();
        return { truckId };
      }),
    createTenant: (name) =>
      enqueue(async () => {
        const s = store.state;
        const at = toIso(clock.now());
        let n = s.tenants.length;
        let ownerMobile = '';
        do {
          ownerMobile = `+917${String(n).padStart(9, '0')}`;
          n += 1;
        } while (s.users.some((u) => u.mobile === ownerMobile));

        const tenantId = newId();
        const companyId = newId();
        const plantId = newId();
        s.tenants.push({
          id: tenantId,
          name,
          settings: { ...DEFAULT_TENANT_SETTINGS },
          createdAt: at,
        });
        s.companies.push({
          id: companyId,
          tenantId,
          code: 'TNT',
          name: `${name} Steels`,
          gstin: null,
          orderPrefix: 'SO-TNT',
          active: true,
          version: 1,
          createdAt: at,
          updatedAt: at,
        });
        s.plants.push({
          id: plantId,
          tenantId,
          companyId,
          name: 'Main',
          location: 'Raipur',
          active: true,
          version: 1,
          createdAt: at,
          updatedAt: at,
        });
        s.users.push({
          id: newId(),
          tenantId,
          name: `${name} Owner`,
          mobile: ownerMobile,
          role: 'owner',
          plantIds: [],
          active: true,
          version: 1,
          preferences: { unitBasis: 'mt' },
          invitedAt: at,
          lastSeenAt: null,
          createdAt: at,
          updatedAt: at,
        });
        store.schedulePersist();
        return { tenantId, ownerMobile, companyId, plantId };
      }),
  };
}
