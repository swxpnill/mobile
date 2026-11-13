import { z } from 'zod';
import { checkGstin, normalizeGstin } from '../gstin.ts';
import { LENGTH_UNITS } from '../products.ts';
import { idSchema, nameSchema, versionSchema } from './common.ts';

/** Whole ₹ per MT, the only rate unit the API speaks. */
export const ratePerMtSchema = z.number().int().min(0).max(10_000_000);
export const commissionPerMtSchema = z.number().int().min(0).max(100_000);

export const PARTY_TYPES = ['customer', 'broker', 'transporter'] as const;
export const partyTypeSchema = z.enum(PARTY_TYPES);
export type PartyType = z.infer<typeof partyTypeSchema>;

/** Stored phone: +91 and 10 digits (mobile or landline with STD code). */
export const phoneSchema = z.string().regex(/^\+91[1-9]\d{9}$/);

/**
 * Phone as typed: spaces, dashes, "+91", "91" or a trunk "0" are dropped; 10 digits must remain,
 * not starting with 0 ("0712 255 1234" → +917122551234).
 */
export const phoneInputSchema = z.string().transform((value, ctx) => {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[1-9]\d{9}$/.test(digits)) {
    ctx.issues.push({ code: 'custom', message: 'Enter a 10-digit number with STD code', input: value });
    return z.NEVER;
  }
  return `+91${digits}`;
});

/** GSTIN as typed; blank means not registered (null). Shape and state must be right. */
export const gstinInputSchema = z
  .string()
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value.trim() === '') return null;
    const check = checkGstin(value);
    if (!check.ok) {
      ctx.issues.push({
        code: 'custom',
        message: check.reason === 'state' ? 'Unknown state code' : 'GSTIN has 15 characters, e.g. 22AAJCA4410K1ZQ',
        input: value,
      });
      return z.NEVER;
    }
    return normalizeGstin(value);
  });

const contactNumberInputSchema = z.object({
  id: idSchema.optional(),
  number: phoneInputSchema,
  label: z.string().trim().max(20),
  whatsapp: z.boolean(),
});
const contactInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  roleLabel: z.string().trim().max(30),
  numbers: z.array(contactNumberInputSchema).min(1).max(5),
});

export const ADDRESS_KINDS = ['bill_to', 'ship_to'] as const;
const addressInputSchema = z.object({
  id: idSchema.optional(),
  kind: z.enum(ADDRESS_KINDS),
  label: z.string().trim().max(40),
  address: z.string().trim().min(1).max(200),
  isDefault: z.boolean(),
});

const partyFields = {
  type: partyTypeSchema,
  name: nameSchema,
  gstin: gstinInputSchema,
  city: z.string().trim().min(1).max(60),
  defaultCommissionPerMt: commissionPerMtSchema.nullable(),
  paymentTermsText: z.string().trim().max(200),
  isSelfTransporter: z.boolean(),
  contacts: z.array(contactInputSchema).max(10),
  addresses: z.array(addressInputSchema).max(20),
};

type PartyShape = {
  type: PartyType;
  defaultCommissionPerMt: number | null;
  addresses: { kind: 'bill_to' | 'ship_to'; isDefault: boolean }[];
};

/** Customers need one bill-to and ship-to sites with exactly one default; only brokers earn commission. */
function partyRules(p: PartyShape, ctx: z.RefinementCtx): void {
  if (p.type !== 'broker' && p.defaultCommissionPerMt !== null) {
    ctx.addIssue({ code: 'custom', path: ['defaultCommissionPerMt'], message: 'Only brokers have a commission' });
  }
  if (p.type === 'customer') {
    const bill = p.addresses.filter((a) => a.kind === 'bill_to');
    const ship = p.addresses.filter((a) => a.kind === 'ship_to');
    if (bill.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['addresses'], message: 'Add one bill-to address' });
    }
    if (ship.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['addresses'], message: 'Add at least one ship-to site' });
    } else if (ship.filter((a) => a.isDefault).length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['addresses'], message: 'Mark one ship-to site as default' });
    }
  }
}

export const partyBodySchema = z.object(partyFields).superRefine(partyRules);
export type PartyBody = z.infer<typeof partyBodySchema>;

export const updatePartyBodySchema = z
  .object({ ...partyFields, version: versionSchema, active: z.boolean() })
  .superRefine(partyRules);
export type UpdatePartyBody = z.infer<typeof updatePartyBodySchema>;

const contactSchema = z.object({
  id: idSchema,
  name: z.string(),
  roleLabel: z.string(),
  numbers: z.array(z.object({ id: idSchema, number: phoneSchema, label: z.string(), whatsapp: z.boolean() })),
});
const addressSchema = z.object({
  id: idSchema,
  kind: z.enum(ADDRESS_KINDS),
  label: z.string(),
  address: z.string(),
  isDefault: z.boolean(),
});
export type PartyAddress = z.infer<typeof addressSchema>;

export const partySchema = z.object({
  id: idSchema,
  type: partyTypeSchema,
  name: z.string(),
  gstin: z.string().nullable(),
  city: z.string(),
  defaultCommissionPerMt: z.number().int().nullable().optional(),
  paymentTermsText: z.string(),
  isSelfTransporter: z.boolean(),
  contacts: z.array(contactSchema),
  addresses: z.array(addressSchema),
  active: z.boolean(),
  version: versionSchema,
  stats: z.object({
    openOrders: z.number().int(),
    pendingKg: z.number().int(),
    fyDispatchedKg: z.number().int(),
  }),
});
export type Party = z.infer<typeof partySchema>;

export const partySummarySchema = z.object({
  id: idSchema,
  type: partyTypeSchema,
  name: z.string(),
  city: z.string(),
  gstin: z.string().nullable(),
  active: z.boolean(),
  people: z.number().int(),
  numbers: z.number().int(),
  pendingKg: z.number().int(),
  defaultCommissionPerMt: z.number().int().nullable().optional(),
});
export type PartySummary = z.infer<typeof partySummarySchema>;

const boolFromQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const partyListQuerySchema = z.object({
  type: partyTypeSchema.optional(),
  q: z.string().trim().max(60).optional(),
  active: boolFromQuery.optional(),
});

export const lengthSchema = z.object({
  value: z.number().int().min(1).max(100),
  unit: z.enum(LENGTH_UNITS),
});

const productFields = {
  category: z.string().trim().min(1).max(30),
  grade: z.string().trim().max(30),
  sizeLabel: z.string().trim().min(1).max(30),
  conversionPerMt: z.number().int().min(0).max(100_000),
  standardLengths: z
    .array(lengthSchema)
    .max(8)
    .superRefine((list, ctx) => {
      list.forEach((l, i) => {
        if (list.findIndex((x) => x.value === l.value && x.unit === l.unit) !== i) {
          ctx.addIssue({ code: 'custom', path: [i], message: 'This length is already listed' });
        }
      });
    }),
  companyIds: z.array(idSchema).min(1, 'Choose at least one company'),
};

export const productBodySchema = z.object(productFields);
export type ProductBody = z.infer<typeof productBodySchema>;

export const updateProductBodySchema = z.object({
  ...productFields,
  version: versionSchema,
  active: z.boolean(),
});
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

export const productSchema = z.object({
  id: idSchema,
  category: z.string(),
  grade: z.string(),
  sizeLabel: z.string(),
  displayName: z.string(),
  tag: z.string(),
  conversionPerMt: z.number().int().optional(),
  standardLengths: z.array(lengthSchema),
  companyIds: z.array(idSchema),
  active: z.boolean(),
  version: versionSchema,
});
export type Product = z.infer<typeof productSchema>;

export const productListQuerySchema = z.object({
  category: z.string().trim().max(30).optional(),
  q: z.string().trim().max(60).optional(),
  companyId: idSchema.optional(),
  active: boolFromQuery.optional(),
});
