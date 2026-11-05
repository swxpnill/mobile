import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_SETTINGS, tenantSettingsSchema } from '@tonnage/shared';
import {
  PEOPLE,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  tokenFor,
  useTarget,
} from '../harness.ts';

export function register(factory: TargetFactory): void {
  describe('contract: settings', () => {
    const target = useTarget(factory);

    it('new tenant settings equal DEFAULT_TENANT_SETTINGS', async () => {
      const t = target();
      const other = await t.fixtures.createTenant('Fresh Metals');
      const owner = await tokenFor(t, { mobile: other.ownerMobile });
      expect(
        expectOk(await call(t, 'GET', '/v1/settings', { token: owner }), tenantSettingsSchema),
      ).toEqual(DEFAULT_TENANT_SETTINGS);
    });

    it('owner PATCH { completionToleranceKg: 500 } → GET returns 500 for every role; other keys unchanged', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const patched = expectOk(
        await call(t, 'PATCH', '/v1/settings', {
          token: owner,
          body: { completionToleranceKg: 500 },
        }),
        tenantSettingsSchema,
      );
      expect(patched).toEqual({ ...DEFAULT_TENANT_SETTINGS, completionToleranceKg: 500 });
      for (const who of [PEOPLE.priya, PEOPLE.ravi]) {
        const s = expectOk(
          await call(t, 'GET', '/v1/settings', { token: await tokenFor(t, who) }),
          tenantSettingsSchema,
        );
        expect(s.completionToleranceKg).toBe(500);
      }
    });

    it('settings are per tenant: a change in one tenant does not reach another', async () => {
      const t = target();
      const other = await t.fixtures.createTenant('Fresh Metals');
      await call(t, 'PATCH', '/v1/settings', {
        token: await tokenFor(t, PEOPLE.rajesh),
        body: { agedOrderDays: 20 },
      });
      const theirs = expectOk(
        await call(t, 'GET', '/v1/settings', {
          token: await tokenFor(t, { mobile: other.ownerMobile }),
        }),
        tenantSettingsSchema,
      );
      expect(theirs.agedOrderDays).toBe(DEFAULT_TENANT_SETTINGS.agedOrderDays);
    });

    it('invalid values → 422 VALIDATION and nothing changes', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      for (const body of [
        { externalUnitBasis: 'lb' },
        { completionToleranceKg: -1 },
        { completionToleranceKg: 0.5 },
        [],
      ]) {
        expectError(
          await call(t, 'PATCH', '/v1/settings', { token: owner, body }),
          422,
          'VALIDATION',
        );
      }
      expect(
        expectOk(await call(t, 'GET', '/v1/settings', { token: owner }), tenantSettingsSchema),
      ).toEqual(DEFAULT_TENANT_SETTINGS);
    });

    it('city_staff PATCH → 403; supervisor GET → 200', async () => {
      const t = target();
      expectError(
        await call(t, 'PATCH', '/v1/settings', {
          token: await tokenFor(t, PEOPLE.priya),
          body: { agedOrderDays: 5 },
        }),
        403,
        'FORBIDDEN',
      );
      expectOk(
        await call(t, 'GET', '/v1/settings', { token: await tokenFor(t, PEOPLE.ravi) }),
        tenantSettingsSchema,
      );
    });
  });
}
