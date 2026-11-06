import { expect, it } from 'vitest';
import { DEFAULT_TENANT_SETTINGS, tenantSettingsSchema } from './settings.ts';

it('defaults', () => {
  expect(tenantSettingsSchema.parse({})).toEqual(DEFAULT_TENANT_SETTINGS);
  expect(DEFAULT_TENANT_SETTINGS).toEqual({
    completionToleranceKg: 1000,
    agedOrderDays: 10,
    defaultPricing: 'basic_conversion',
    allowHardDeleteAfterDispatch: true,
    externalUnitBasis: 'mt',
    orderNumberFormat: 'SO-YYMM-0001',
  });
});
it('rejects invalid', () => {
  expect(() => tenantSettingsSchema.parse({ completionToleranceKg: -1 })).toThrow();
});
it('pricing method enum', () => {
  expect(() => tenantSettingsSchema.parse({ defaultPricing: 'flat' })).toThrow();
  expect(tenantSettingsSchema.parse({ defaultPricing: 'direct' }).defaultPricing).toBe('direct');
});
