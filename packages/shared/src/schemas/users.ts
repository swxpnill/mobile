import { z } from 'zod';
import {
  idSchema,
  mobileInputSchema,
  nameSchema,
  normalizedMobileSchema,
  roleSchema,
  versionSchema,
} from './common.ts';

export const USER_STATUSES = ['active', 'invited', 'inactive'] as const;

export const userSchema = z.object({
  id: idSchema,
  name: nameSchema,
  mobile: normalizedMobileSchema,
  role: roleSchema,
  plantIds: z.array(idSchema),
  active: z.boolean(),
  status: z.enum(USER_STATUSES),
  version: versionSchema,
});
export type User = z.infer<typeof userSchema>;

// Plant-count rules depend on role and are enforced server-side (PLANT_RULE), not here.
export const inviteUserBodySchema = z.object({
  name: nameSchema,
  mobile: mobileInputSchema,
  role: roleSchema,
  plantIds: z.array(idSchema),
});
export type InviteUserBody = z.output<typeof inviteUserBodySchema>;
export type InviteUserBodyInput = z.input<typeof inviteUserBodySchema>;

export const updateUserBodySchema = z.object({
  name: nameSchema.optional(),
  role: roleSchema.optional(),
  plantIds: z.array(idSchema).optional(),
  version: versionSchema,
});
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
