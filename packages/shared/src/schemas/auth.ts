import { z } from 'zod';
import { idSchema, mobileInputSchema } from './common.ts';

export const requestCodeBodySchema = z.object({ mobile: mobileInputSchema });
export type RequestCodeBody = z.output<typeof requestCodeBodySchema>;
export type RequestCodeBodyInput = z.input<typeof requestCodeBodySchema>;

export const verifyCodeBodySchema = z.object({
  mobile: mobileInputSchema,
  code: z.string().regex(/^\d{6}$/),
  deviceId: idSchema,
  tenantId: idSchema.optional(),
});
export type VerifyCodeBody = z.output<typeof verifyCodeBodySchema>;
export type VerifyCodeBodyInput = z.input<typeof verifyCodeBodySchema>;

export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessExpiresAt: z.iso.datetime(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: idSchema,
});
export type RefreshBody = z.infer<typeof refreshBodySchema>;
