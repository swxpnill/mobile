import { z } from 'zod';
import { ERROR_CODES } from '../errors.ts';
import { idSchema, nameSchema } from './common.ts';

/** Every non-2xx response body: `{ code, message, details? }` (spec §7 error contract). */
export const apiErrorBodySchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

/** `details` of a `422 VALIDATION` response. */
export const validationDetailsSchema = z
  .array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string(),
    }),
  )
  .min(1);
export type ValidationDetails = z.infer<typeof validationDetailsSchema>;

/** `details` of a `409 TENANT_CHOICE_REQUIRED` response, sorted by tenant name. */
export const tenantChoiceDetailsSchema = z
  .array(z.object({ tenantId: idSchema, tenantName: nameSchema }))
  .min(2);
export type TenantChoiceDetails = z.infer<typeof tenantChoiceDetailsSchema>;

/** `200` body of `POST /v1/auth/request-code` — identical for known and unknown numbers. */
export const requestCodeResponseSchema = z.object({
  resendAfterSeconds: z.number().int().positive(),
});
export type RequestCodeResponse = z.infer<typeof requestCodeResponseSchema>;

/** `GET /v1/meta` — used by the app's force-update check. */
export const metaSchema = z.object({
  minSupportedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  serverTime: z.iso.datetime(),
});
export type Meta = z.infer<typeof metaSchema>;
