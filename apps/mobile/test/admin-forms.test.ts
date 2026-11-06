import { type Company, type Plant, SAMPLE_WORLD, type User } from '@tonnage/shared';
import { ApiError } from '../src/api/client';
import {
  companyFormSchema,
  companyPatch,
  fieldErrorsFrom,
  inviteFormSchema,
  parseAgedDays,
  pickerPlantLabel,
  rolePreview,
  supervisorCaption,
  toCompanyBody,
  userPatch,
  userScopeLine,
} from '../src/admin/forms';
import { messageFor } from '../src/screens/messages';

const { ids } = SAMPLE_WORLD;
const companies: Company[] = SAMPLE_WORLD.companies.map((c) => ({
  ...c,
  active: true,
  version: 1,
}));
const plants: Plant[] = SAMPLE_WORLD.plants.map((p) => ({ ...p, active: true, version: 1 }));
const tilda = plants.find((p) => p.id === ids.plants.tilda)!;
const nap = companies.find((c) => c.id === ids.companies.NAP)!;

const okCompany = {
  code: 'krm',
  name: '  Kalinga Rolling Mills ',
  gstin: '',
  orderPrefix: 'SO-KRM',
};

describe('company form', () => {
  it('uppercases and trims the code, empty GSTIN becomes null in the body', () => {
    const v = companyFormSchema.parse(okCompany);
    expect(v.code).toBe('KRM');
    expect(toCompanyBody(v)).toEqual({
      code: 'KRM',
      name: 'Kalinga Rolling Mills',
      gstin: null,
      orderPrefix: 'SO-KRM',
    });
  });

  it('invalid GSTIN shows "Enter a valid 15-character GSTIN"; a lowercase valid one is accepted', () => {
    const bad = companyFormSchema.safeParse({ ...okCompany, gstin: '22AADFK7781M1' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({
      path: ['gstin'],
      message: 'Enter a valid 15-character GSTIN',
    });
    expect(companyFormSchema.parse({ ...okCompany, gstin: ' 22aadfk7781m1z2 ' }).gstin).toBe(
      '22AADFK7781M1Z2',
    );
  });

  it('code must be 2–5 letters', () => {
    const r = companyFormSchema.safeParse({ ...okCompany, code: 'K1' });
    expect(r.error?.issues[0]?.message).toBe('Use 2 to 5 letters, like AIP');
  });

  it('patch sends only changed fields plus version; nothing changed → null', () => {
    const krm = companies.find((c) => c.code === 'KRM')!;
    const same = companyFormSchema.parse({
      code: krm.code,
      name: krm.name,
      gstin: krm.gstin ?? '',
      orderPrefix: krm.orderPrefix,
    });
    expect(companyPatch(krm, same)).toBeNull();
    expect(companyPatch(krm, { ...same, name: 'Kalinga Steel' })).toEqual({
      name: 'Kalinga Steel',
      version: 1,
    });
  });
});

describe('invite form', () => {
  const base = { name: 'Deepak Sahu', mobile: '99261 44508', plantIds: [] as string[] };

  it('normalises the mobile and requires a role', () => {
    const r = inviteFormSchema.safeParse({ ...base, role: undefined });
    expect(r.error?.issues.map((i) => i.message)).toContain('Choose a role');
    const ok = inviteFormSchema.parse({ ...base, role: 'city_staff' });
    expect(ok.mobile).toBe('+919926144508');
  });

  it('rejects a bad mobile with the sign-in wording', () => {
    const r = inviteFormSchema.safeParse({ ...base, mobile: '12345', role: 'owner' });
    expect(r.error?.issues[0]).toMatchObject({
      path: ['mobile'],
      message: 'Enter a 10-digit mobile number',
    });
  });

  it('plant rules per role: supervisor exactly one, plant head at least one, others none', () => {
    const sup = inviteFormSchema.safeParse({ ...base, role: 'supervisor' });
    expect(sup.error?.issues[0]).toMatchObject({
      path: ['plantIds'],
      message: 'Choose the plant they work at',
    });
    const head = inviteFormSchema.safeParse({ ...base, role: 'plant_head' });
    expect(head.error?.issues[0]?.message).toBe('Choose at least one plant');
    // Plants left over from a previous role choice are dropped, not sent.
    expect(
      inviteFormSchema.parse({ ...base, role: 'owner', plantIds: [ids.plants.tilda] }).plantIds,
    ).toEqual([]);
    expect(
      inviteFormSchema.parse({
        ...base,
        role: 'supervisor',
        plantIds: [ids.plants.tilda, ids.plants.tilda],
      }).plantIds,
    ).toEqual([ids.plants.tilda]);
  });
});

describe('role preview', () => {
  it('fills {plant} with the chosen plant and uses the first name', () => {
    const p = rolePreview('supervisor', 'Deepak Sahu', ['Nandan · Tilda']);
    expect(p.title).toBe('Deepak will be able to');
    expect(p.can).toContain('See trucks assigned to Nandan · Tilda');
    expect(p.cannot).toContain('See rates, order values or broker money');
  });

  it('falls back to "They" and "their plant" before anything is typed or picked', () => {
    const p = rolePreview('plant_head', '  ', []);
    expect(p.title).toBe('They will be able to');
    expect(p.can[0]).toBe('See orders and dispatch of their plant');
    expect(rolePreview('plant_head', 'Kiran', ['A · X', 'B · Y']).can[0]).toBe(
      'See orders and dispatch of A · X and B · Y',
    );
  });
});

describe('labels', () => {
  it('plant picker label uses two words of the company name', () => {
    expect(pickerPlantLabel(tilda, nap)).toBe('Nandan Alloys · Tilda');
  });

  it('supervisor caption counts active supervisors at the plant', () => {
    const u = (over: Partial<User>): User => ({
      id: '019a4c00-0000-7000-8000-0000000000aa',
      name: 'X',
      mobile: '+919826100099',
      role: 'supervisor',
      plantIds: [tilda.id],
      active: true,
      status: 'active',
      version: 1,
      ...over,
    });
    expect(supervisorCaption(tilda.id, [])).toBe('No supervisor yet');
    expect(supervisorCaption(tilda.id, [u({})])).toBe('1 supervisor already');
    expect(supervisorCaption(tilda.id, [u({}), u({}), u({ active: false })])).toBe(
      '2 supervisors already',
    );
  });

  it('user scope line: "All units" or the plants with "only"', () => {
    const sup = { role: 'supervisor' as const, plantIds: [tilda.id] };
    expect(userScopeLine({ role: 'owner', plantIds: [] }, companies, plants)).toBe('All units');
    expect(userScopeLine(sup, companies, plants)).toBe('Nandan · Tilda only');
    expect(
      userScopeLine(
        { role: 'plant_head', plantIds: [ids.plants.siltara, tilda.id] },
        companies,
        plants,
      ),
    ).toBe('Aarav · Siltara, Nandan · Tilda');
  });
});

describe('user patch', () => {
  it('sends only role/plants that changed; none → null', () => {
    const user = { role: 'supervisor' as const, plantIds: [tilda.id], version: 3 };
    expect(userPatch(user, { role: 'supervisor', plantIds: [tilda.id] })).toBeNull();
    expect(userPatch(user, { role: 'plant_head', plantIds: [tilda.id] })).toEqual({
      role: 'plant_head',
      plantIds: [tilda.id],
      version: 3,
    });
  });
});

describe('server errors to fields', () => {
  it('maps VALIDATION details paths to the form fields it knows', () => {
    const e = new ApiError(422, 'VALIDATION', 'x', [
      { path: ['code'], message: 'This code is already used by another company' },
      { path: ['other'], message: 'ignored' },
    ]);
    expect(fieldErrorsFrom(e, ['code', 'name'])).toEqual({
      code: 'This code is already used by another company',
    });
    expect(fieldErrorsFrom(new Error('x'), ['code'])).toEqual({});
  });
});

describe('admin error copy', () => {
  it('names the business rule instead of a generic failure', () => {
    const e = (code: ConstructorParameters<typeof ApiError>[1]) => new ApiError(409, code, 'x');
    expect(messageFor(e('LAST_OWNER'))).toBe("You can't remove the last owner.");
    expect(messageFor(e('STALE'))).toBe('Someone else changed this. Showing the latest.');
    expect(messageFor(e('MOBILE_EXISTS'))).toBe('This number already has an account');
    expect(messageFor(new ApiError(403, 'FORBIDDEN', 'x'))).toBe("You don't have access to this.");
    expect(messageFor(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(
      'This was removed or is no longer available.',
    );
  });
});

describe('settings inputs', () => {
  it('aged-order days is a whole number from 1 to 365', () => {
    expect(parseAgedDays('10')).toEqual({ ok: true, value: 10 });
    expect(parseAgedDays('0')).toEqual({ ok: false, error: 'Enter 1 to 365 days' });
    expect(parseAgedDays('2.5')).toEqual({ ok: false, error: 'Enter 1 to 365 days' });
  });
});
