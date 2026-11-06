import { describe, expect, it } from 'vitest';
import {
  companySchema,
  createCompanyBodySchema,
  createPlantBodySchema,
  gstinSchema,
  inviteUserBodySchema,
  meSchema,
  plantSchema,
  refreshBodySchema,
  requestCodeBodySchema,
  tokenPairSchema,
  updateCompanyBodySchema,
  updatePlantBodySchema,
  updatePreferencesBodySchema,
  updateUserBodySchema,
  userSchema,
  verifyCodeBodySchema,
} from '../index.ts';

const id = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e9f0a1b';
const id2 = '7a1c9d2e-8b3f-4c5d-a6e7-1f2a3b4c5d6e';

describe('auth schemas', () => {
  it('normalises mobile on request-code', () => {
    expect(requestCodeBodySchema.parse({ mobile: '98260 12345' })).toEqual({ mobile: '+919826012345' });
    expect(requestCodeBodySchema.safeParse({ mobile: '123' }).success).toBe(false);
  });
  it('verify-code', () => {
    const ok = verifyCodeBodySchema.parse({ mobile: '9826012345', code: '123456', deviceId: id });
    expect(ok.mobile).toBe('+919826012345');
    expect(verifyCodeBodySchema.safeParse({ mobile: '9826012345', code: '12345', deviceId: id }).success).toBe(false);
    expect(verifyCodeBodySchema.safeParse({ mobile: '9826012345', code: '123456', deviceId: 'x' }).success).toBe(false);
    expect(
      verifyCodeBodySchema.safeParse({ mobile: '9826012345', code: '123456', deviceId: id, tenantId: id2 }).success,
    ).toBe(true);
  });
  it('token pair and refresh', () => {
    const pair = { accessToken: 'a', refreshToken: 'r', accessExpiresAt: '2026-11-04T10:00:00.000Z' };
    expect(tokenPairSchema.safeParse(pair).success).toBe(true);
    expect(tokenPairSchema.safeParse({ ...pair, accessExpiresAt: 'tomorrow' }).success).toBe(false);
    expect(refreshBodySchema.safeParse({ refreshToken: 'r', deviceId: id }).success).toBe(true);
    expect(refreshBodySchema.safeParse({ refreshToken: 'r' }).success).toBe(false);
  });
});

describe('me schemas', () => {
  const me = {
    id,
    name: 'Aarav',
    mobile: '+919826012345',
    role: 'owner',
    plantIds: [],
    preferences: { unitBasis: 'mt' },
    tenant: { id: id2, name: 'Aarav Steels' },
  };
  it('parses me', () => {
    expect(meSchema.safeParse(me).success).toBe(true);
    expect(meSchema.safeParse({ ...me, role: 'admin' }).success).toBe(false);
    expect(meSchema.safeParse({ ...me, mobile: '9826012345' }).success).toBe(false);
  });
  it('update preferences', () => {
    expect(updatePreferencesBodySchema.safeParse({ unitBasis: 'kg' }).success).toBe(true);
    expect(updatePreferencesBodySchema.safeParse({ unitBasis: 'ton' }).success).toBe(false);
  });
});

describe('org schemas', () => {
  it('gstin', () => {
    expect(gstinSchema.safeParse('22AAJCA4410K1ZQ').success).toBe(true);
    expect(gstinSchema.safeParse('22AAJCA4410K1Z').success).toBe(false);
  });
  const company = { id, code: 'AAR', name: 'Aarav', gstin: null, orderPrefix: 'SO', active: true, version: 1 };
  it('company', () => {
    expect(companySchema.safeParse(company).success).toBe(true);
    expect(companySchema.safeParse({ ...company, code: 'aar' }).success).toBe(false);
    expect(companySchema.safeParse({ ...company, version: 0 }).success).toBe(false);
  });
  it('create/update company', () => {
    const body = { code: 'AAR', name: ' Aarav ', gstin: '22AAJCA4410K1ZQ', orderPrefix: 'SO' };
    expect(createCompanyBodySchema.parse(body).name).toBe('Aarav');
    expect(createCompanyBodySchema.safeParse({ ...body, name: '  ' }).success).toBe(false);
    expect(updateCompanyBodySchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(updateCompanyBodySchema.safeParse({ name: 'X', version: 2, active: false }).success).toBe(true);
  });
  const plant = { id, companyId: id2, name: 'Raipur', location: 'Siltara', active: true, version: 3 };
  it('plant', () => {
    expect(plantSchema.safeParse(plant).success).toBe(true);
    expect(plantSchema.safeParse({ ...plant, companyId: 'x' }).success).toBe(false);
    expect(createPlantBodySchema.safeParse({ companyId: id2, name: 'R', location: 'S' }).success).toBe(true);
    expect(createPlantBodySchema.safeParse({ companyId: id2, name: '', location: 'S' }).success).toBe(false);
    expect(updatePlantBodySchema.safeParse({ location: 'Z', version: 1 }).success).toBe(true);
    expect(updatePlantBodySchema.safeParse({ location: 'Z' }).success).toBe(false);
  });
});

describe('user schemas', () => {
  const user = {
    id, name: 'Deepak', mobile: '+919876543210', role: 'supervisor', plantIds: [id2],
    active: true, status: 'invited', version: 1,
  };
  it('user', () => {
    expect(userSchema.safeParse(user).success).toBe(true);
    expect(userSchema.safeParse({ ...user, status: 'gone' }).success).toBe(false);
  });
  it('invite normalises mobile', () => {
    expect(
      inviteUserBodySchema.parse({ name: 'Deepak Sahu', mobile: '9876543210', role: 'supervisor', plantIds: [id] }).mobile,
    ).toBe('+919876543210');
    expect(
      inviteUserBodySchema.safeParse({ name: 'D', mobile: '12', role: 'supervisor', plantIds: [id] }).success,
    ).toBe(false);
  });
  it('update user', () => {
    expect(updateUserBodySchema.safeParse({ role: 'plant_head', version: 2 }).success).toBe(true);
    expect(updateUserBodySchema.safeParse({ role: 'plant_head' }).success).toBe(false);
  });
});
