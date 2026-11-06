import { z } from 'zod';
import { idSchema, nameSchema, versionSchema } from './common.ts';

export const gstinSchema = z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);
export type Gstin = z.infer<typeof gstinSchema>;

const codeSchema = z.string().regex(/^[A-Z]{2,5}$/);
const orderPrefixSchema = z.string().trim().min(1).max(120);

export const companySchema = z.object({
  id: idSchema,
  code: codeSchema,
  name: nameSchema,
  gstin: gstinSchema.nullable(),
  orderPrefix: orderPrefixSchema,
  active: z.boolean(),
  version: versionSchema,
});
export type Company = z.infer<typeof companySchema>;

export const createCompanyBodySchema = z.object({
  code: codeSchema,
  name: nameSchema,
  gstin: gstinSchema.nullable(),
  orderPrefix: orderPrefixSchema,
});
export type CreateCompanyBody = z.infer<typeof createCompanyBodySchema>;

export const updateCompanyBodySchema = createCompanyBodySchema.partial().extend({
  version: versionSchema,
  active: z.boolean().optional(),
});
export type UpdateCompanyBody = z.infer<typeof updateCompanyBodySchema>;

export const plantSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  name: nameSchema,
  location: nameSchema,
  active: z.boolean(),
  version: versionSchema,
});
export type Plant = z.infer<typeof plantSchema>;

export const createPlantBodySchema = z.object({
  companyId: idSchema,
  name: nameSchema,
  location: nameSchema,
});
export type CreatePlantBody = z.infer<typeof createPlantBodySchema>;

export const updatePlantBodySchema = createPlantBodySchema.partial().extend({
  version: versionSchema,
  active: z.boolean().optional(),
});
export type UpdatePlantBody = z.infer<typeof updatePlantBodySchema>;
