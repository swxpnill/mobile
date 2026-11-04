import { z } from 'zod';

export const PRICING_METHODS = ['direct', 'basic_conversion'] as const;
export type PricingMethod = (typeof PRICING_METHODS)[number];

export const tenantSettingsSchema = z.object({
  completionToleranceKg: z.number().int().min(0).default(1000),
  agedOrderDays: z.number().int().min(1).default(10),
  defaultPricing: z.enum(PRICING_METHODS).default('basic_conversion'),
  allowHardDeleteAfterDispatch: z.boolean().default(true),
  externalUnitBasis: z.enum(['mt', 'kg']).default('mt'),
  orderNumberFormat: z.string().min(1).default('SO-YYMM-0001'),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const DEFAULT_TENANT_SETTINGS: TenantSettings = tenantSettingsSchema.parse({});
