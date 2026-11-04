import { z } from 'zod';
import { normalizeIndianMobile } from '../mobile.ts';
import { ROLES } from '../roles.ts';
import type { UnitBasis } from '../units.ts';

export const idSchema = z.uuid();
export const versionSchema = z.number().int().positive();
export const roleSchema = z.enum(ROLES);
export const nameSchema = z.string().trim().min(1).max(120);

const UNIT_BASES = ['mt', 'kg'] as const satisfies readonly UnitBasis[];
export const unitBasisSchema = z.enum(UNIT_BASES);

/** Already-normalised mobile (+91XXXXXXXXXX), as stored and returned by the API. */
export const normalizedMobileSchema = z.string().regex(/^\+91[6-9]\d{9}$/);

/** Mobile as typed by a user; output is the normalised +91 form. */
export const mobileInputSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeIndianMobile(value);
  if (normalized === null) {
    ctx.issues.push({ code: 'custom', message: 'Enter a valid 10-digit mobile number', input: value });
    return z.NEVER;
  }
  return normalized;
});
