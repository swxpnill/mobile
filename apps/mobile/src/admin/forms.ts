import {
  type Company,
  type CreateCompanyBody,
  describeRole,
  gstinSchema,
  normalizeIndianMobile,
  type Plant,
  plantRule,
  type Role,
  ROLES,
  type UpdateCompanyBody,
  type UpdateUserBody,
  type User,
  validationDetailsSchema,
} from '@tonnage/shared';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { shortCompanyName } from '../nav/roles';

/*
 * Admin form rules (pure, no React). The API re-checks everything with the shared schemas; these
 * exist to give the right message on the right field before a round trip, in the client's words.
 */

const required = (message: string) => z.string().trim().min(1, message).max(120, 'Too long');

// ── Company ─────────────────────────────────────────────────────────────────────────────────────

export const companyFormSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2,5}$/, 'Use 2 to 5 letters, like AIP')),
  name: required('Enter the company name'),
  // Optional (a unit may not be GST-registered yet). Spaces and case do not matter when typed.
  gstin: z
    .string()
    .transform((s) => s.replace(/\s+/g, '').toUpperCase())
    .refine((s) => s === '' || gstinSchema.safeParse(s).success, {
      message: 'Enter a valid 15-character GSTIN',
    }),
  orderPrefix: z
    .string()
    .trim()
    .min(1, 'Enter an order number prefix')
    .max(20, 'Keep it under 20 characters'),
});
export type CompanyFormInput = z.input<typeof companyFormSchema>;
export type CompanyFormValues = z.output<typeof companyFormSchema>;

export function companyFormDefaults(c?: Company): CompanyFormInput {
  return c
    ? { code: c.code, name: c.name, gstin: c.gstin ?? '', orderPrefix: c.orderPrefix }
    : { code: '', name: '', gstin: '', orderPrefix: '' };
}

/** The prefix the canvas uses ("SO-AIP"); filled in while the owner types a new code. */
export const suggestPrefix = (code: string) => `SO-${code.trim().toUpperCase()}`;

export function toCompanyBody(v: CompanyFormValues): CreateCompanyBody {
  return {
    code: v.code,
    name: v.name,
    gstin: v.gstin === '' ? null : v.gstin,
    orderPrefix: v.orderPrefix,
  };
}

/** Only what changed, plus the version it was read at. `null` when nothing changed. */
export function companyPatch(c: Company, v: CompanyFormValues): UpdateCompanyBody | null {
  const next = toCompanyBody(v);
  const patch: UpdateCompanyBody = { version: c.version };
  let changed = false;
  for (const k of ['code', 'name', 'gstin', 'orderPrefix'] as const) {
    if (next[k] !== c[k]) {
      (patch as Record<string, unknown>)[k] = next[k];
      changed = true;
    }
  }
  return changed ? patch : null;
}

// ── Plant ───────────────────────────────────────────────────────────────────────────────────────

export const plantFormSchema = z.object({
  name: required('Enter the plant name'),
  location: required('Enter the town or city'),
});
export type PlantFormValues = z.output<typeof plantFormSchema>;

// ── Users ───────────────────────────────────────────────────────────────────────────────────────

/** Role choices in the order the canvas shows them: least access first, owner last. */
export const ROLE_CHOICES: { role: Role; label: string; detail: string }[] = [
  {
    role: 'city_staff',
    label: 'City staff / Accounts',
    detail: 'Orders, vehicles, reports and broker payments for every unit',
  },
  {
    role: 'plant_head',
    label: 'Plant head',
    detail: 'Sees orders and dispatch of their plants, no money',
  },
  {
    role: 'supervisor',
    label: 'Loading supervisor',
    detail: 'Captures tare and gross weight at one plant',
  },
  { role: 'owner', label: 'Owner · admin', detail: 'Full access, including delete and settings' },
];

/** Keeps the plant list consistent with the role: none for all-unit roles, de-duplicated. */
export function plantsForRole(role: Role, plantIds: readonly string[]): string[] {
  return plantRule(role).max === 0 ? [] : [...new Set(plantIds)];
}

function plantRuleIssue(role: Role, count: number): string | null {
  const rule = plantRule(role);
  if (count >= rule.min && count <= rule.max) return null;
  if (role === 'supervisor') return 'Choose the plant they work at';
  return 'Choose at least one plant';
}

const roleField = z.enum(ROLES, { error: 'Choose a role' });

export const inviteFormSchema = z
  .object({
    name: required('Enter their full name'),
    mobile: z.string().transform((value, ctx) => {
      const n = normalizeIndianMobile(value);
      if (n === null) {
        ctx.issues.push({
          code: 'custom',
          message: 'Enter a 10-digit mobile number',
          input: value,
        });
        return z.NEVER;
      }
      return n;
    }),
    role: roleField,
    plantIds: z.array(z.string()),
  })
  .transform((v, ctx) => {
    const plantIds = plantsForRole(v.role, v.plantIds);
    const issue = plantRuleIssue(v.role, plantIds.length);
    if (issue) {
      ctx.issues.push({ code: 'custom', path: ['plantIds'], message: issue, input: v.plantIds });
      return z.NEVER;
    }
    return { ...v, plantIds };
  });
export type InviteFormInput = {
  name: string;
  mobile: string;
  role: Role | undefined;
  plantIds: string[];
};
export type InviteFormValues = z.output<typeof inviteFormSchema>;

/** Role and plants on the user detail screen. */
export const accessFormSchema = z
  .object({ role: roleField, plantIds: z.array(z.string()) })
  .transform((v, ctx) => {
    const plantIds = plantsForRole(v.role, v.plantIds);
    const issue = plantRuleIssue(v.role, plantIds.length);
    if (issue) {
      ctx.issues.push({ code: 'custom', path: ['plantIds'], message: issue, input: v.plantIds });
      return z.NEVER;
    }
    return { role: v.role, plantIds };
  });
export type AccessFormValues = z.output<typeof accessFormSchema>;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

export function userPatch(
  u: Pick<User, 'role' | 'plantIds' | 'version'>,
  v: AccessFormValues,
): UpdateUserBody | null {
  const patch: UpdateUserBody = { version: u.version };
  if (v.role !== u.role) patch.role = v.role;
  // Send plants with any role change so the server never has to guess them.
  if (patch.role !== undefined || !sameSet(v.plantIds, u.plantIds)) patch.plantIds = v.plantIds;
  return patch.role === undefined && patch.plantIds === undefined ? null : patch;
}

/** The "{name} will be able to ✓ … ✕ …" box, from the same policy the API enforces. */
export function rolePreview(
  role: Role,
  fullName: string,
  plantLabels: readonly string[],
): { title: string; can: string[]; cannot: string[] } {
  const first = fullName.trim().split(/\s+/)[0];
  const plant =
    plantLabels.length === 0
      ? 'their plant'
      : plantLabels.length === 1
        ? plantLabels[0]!
        : `${plantLabels.slice(0, -1).join(', ')} and ${plantLabels.at(-1)!}`;
  const d = describeRole(role);
  const fill = (s: string) => s.replace('{plant}', plant);
  return {
    title: `${first || 'They'} will be able to`,
    can: d.can.map(fill),
    cannot: d.cannot.map(fill),
  };
}

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────

/** "Nandan Alloys · Tilda" — the plant picker row (canvas Invite user). */
export function pickerPlantLabel(p: Plant, c: Company | undefined): string {
  if (!c) return p.name;
  return `${c.name.split(/\s+/).slice(0, 2).join(' ')} · ${p.name}`;
}

/** "Nandan · Tilda" — short form used in lists and the preview. */
export function shortPlantLabel(p: Plant, c: Company | undefined): string {
  return c ? `${shortCompanyName(c.name)} · ${p.name}` : p.name;
}

export function supervisorCaption(plantId: string, users: readonly User[]): string {
  const n = users.filter(
    (u) => u.active && u.role === 'supervisor' && u.plantIds.includes(plantId),
  ).length;
  if (n === 0) return 'No supervisor yet';
  return `${n} supervisor${n === 1 ? '' : 's'} already`;
}

/** Users list line: "All units", "Nandan · Tilda only" or several plants. */
export function userScopeLine(
  u: Pick<User, 'role' | 'plantIds'>,
  companies: readonly Company[] | undefined,
  plants: readonly Plant[] | undefined,
): string {
  if (plantRule(u.role).max === 0) return 'All units';
  const labels = u.plantIds.flatMap((id) => {
    const p = plants?.find((x) => x.id === id);
    return p
      ? [
          shortPlantLabel(
            p,
            companies?.find((c) => c.id === p.companyId),
          ),
        ]
      : [];
  });
  if (labels.length === 0) return 'No plant';
  return labels.length === 1 ? `${labels[0]} only` : labels.join(', ');
}

// ── Errors and settings ─────────────────────────────────────────────────────────────────────────

/** `422 VALIDATION` details → `{ field: message }` for the fields this form shows. */
export function fieldErrorsFrom<F extends string>(
  e: unknown,
  fields: readonly F[],
): Partial<Record<F, string>> {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION') return {};
  const parsed = validationDetailsSchema.safeParse(e.details);
  if (!parsed.success) return {};
  const out: Partial<Record<F, string>> = {};
  for (const d of parsed.data) {
    const f = d.path[0];
    if (typeof f === 'string' && (fields as readonly string[]).includes(f) && !out[f as F]) {
      out[f as F] = d.message;
    }
  }
  return out;
}

export const AGED_DAYS_ERROR = 'Enter 1 to 365 days';

export function parseAgedDays(
  input: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const s = input.trim();
  if (!/^\d{1,3}$/.test(s)) return { ok: false, error: AGED_DAYS_ERROR };
  const n = Number(s);
  return n >= 1 && n <= 365 ? { ok: true, value: n } : { ok: false, error: AGED_DAYS_ERROR };
}
