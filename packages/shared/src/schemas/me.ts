import { z } from 'zod';
import { idSchema, nameSchema, normalizedMobileSchema, roleSchema, unitBasisSchema } from './common.ts';

export const meSchema = z.object({
  id: idSchema,
  name: nameSchema,
  mobile: normalizedMobileSchema,
  role: roleSchema,
  plantIds: z.array(idSchema),
  preferences: z.object({ unitBasis: unitBasisSchema }),
  tenant: z.object({ id: idSchema, name: nameSchema }),
});
export type Me = z.infer<typeof meSchema>;

export const updatePreferencesBodySchema = z.object({ unitBasis: unitBasisSchema });
export type UpdatePreferencesBody = z.infer<typeof updatePreferencesBodySchema>;
