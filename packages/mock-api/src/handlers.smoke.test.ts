import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_SETTINGS,
  SAMPLE_WORLD,
  companySchema,
  meSchema,
  plantSchema,
  tokenPairSchema,
  userSchema,
  type HttpMethod,
  type TokenPair,
} from '@tonnage/shared';
import { createFakeClock } from './clock.ts';
import { createMockApi, type MockApi } from './index.ts';

const { ids } = SAMPLE_WORLD;
const DEV = '019a4c00-00ff-7000-8000-000000000001';
const DEV2 = '019a4c00-00ff-7000-8000-000000000002';
const RANDOM_ID = '019a4c00-0fff-7000-8000-000000000999';
const MIN = 60_000;

let api: MockApi;
let clock: ReturnType<typeof createFakeClock>;
let keyN = 0;

beforeEach(async () => {
  clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  api = await createMockApi({ clock });
});

async function call(
  method: HttpMethod,
  path: string,
  opts: { token?: string; body?: unknown; key?: string | true } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers['idempotency-key'] = opts.key === true ? `k-${++keyN}` : opts.key;
  const res = await api.transport.request({ method, path, headers, body: opts.body });
  return res as { status: number; headers: Record<string, string>; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function signIn(mobile: string, deviceId = DEV, tenantId?: string): Promise<TokenPair> {
  expect((await call('POST', '/v1/auth/request-code', { body: { mobile } })).status).toBe(200);
  const v = await call('POST', '/v1/auth/verify', {
    body: { mobile, code: '123456', deviceId, tenantId },
  });
  expect(v.status).toBe(200);
  return tokenPairSchema.parse(v.body);
}
const as = async (userId: string) => (await api.controls.signInAs(userId, DEV)).accessToken;

describe('auth', () => {
  it('request-code is identical for known and unknown numbers', async () => {
    const a = await call('POST', '/v1/auth/request-code', { body: { mobile: '9826100012' } });
    const b = await call('POST', '/v1/auth/request-code', { body: { mobile: '9999999999' } });
    expect(a).toEqual(b);
    expect(a.body).toEqual({ resendAfterSeconds: 30 });
    expect(
      (await call('POST', '/v1/auth/request-code', { body: { mobile: '12345' } })).status,
    ).toBe(422);
  });

  it('verify → tokens → /me; lastSeenAt set (Deepak becomes active)', async () => {
    const pair = await signIn('+91 98261 00017');
    const me = await call('GET', '/v1/me', { token: pair.accessToken });
    expect(meSchema.parse(me.body).name).toBe('Deepak Sahu');
    const users = await call('GET', '/v1/users', { token: await as(ids.users.rajesh) });
    expect(users.body.find((u: { id: string }) => u.id === ids.users.deepak).status).toBe('active');
  });

  it('wrong code, lockout, expiry, resend, consumed', async () => {
    const mobile = '9826100012';
    await call('POST', '/v1/auth/request-code', { body: { mobile } });
    const wrong = { mobile, code: '000000', deviceId: DEV };
    for (let i = 0; i < 4; i++) {
      expect((await call('POST', '/v1/auth/verify', { body: wrong })).body.code).toBe(
        'OTP_INVALID',
      );
    }
    const fifth = await call('POST', '/v1/auth/verify', { body: wrong });
    expect([fifth.status, fifth.body.code]).toEqual([429, 'OTP_LOCKED']);
    const right = { mobile, code: '123456', deviceId: DEV };
    expect((await call('POST', '/v1/auth/verify', { body: right })).body.code).toBe('OTP_LOCKED');
    expect((await call('POST', '/v1/auth/request-code', { body: { mobile } })).body.code).toBe(
      'OTP_LOCKED',
    );
    clock.advance(15 * MIN);
    await signIn(mobile);

    clock.advance(MIN);
    await call('POST', '/v1/auth/request-code', { body: { mobile } });
    const again = await call('POST', '/v1/auth/request-code', { body: { mobile } });
    expect([again.status, again.body.code]).toEqual([429, 'OTP_RESEND_TOO_SOON']);
    clock.advance(5 * MIN);
    const exp = await call('POST', '/v1/auth/verify', { body: right });
    expect([exp.status, exp.body.code]).toEqual([401, 'OTP_EXPIRED']);

    await signIn(mobile);
    const reused = await call('POST', '/v1/auth/verify', { body: right });
    expect([reused.status, reused.body.code]).toEqual([401, 'OTP_INVALID']);
  });

  it('deactivated user cannot verify; tenant choice across tenants', async () => {
    const owner = await as(ids.users.rajesh);
    expect(
      (await call('POST', `/v1/users/${ids.users.amit}/deactivate`, { token: owner })).status,
    ).toBe(200);
    await call('POST', '/v1/auth/request-code', { body: { mobile: '9425067890' } });
    const v = await call('POST', '/v1/auth/verify', {
      body: { mobile: '9425067890', code: '123456', deviceId: DEV },
    });
    expect([v.status, v.body.code]).toEqual([401, 'OTP_INVALID']);

    const t = await api.fixtures.createTenant('Bansal Metals');
    const other = await signIn(t.ownerMobile);
    const invited = await call('POST', '/v1/users', {
      token: other.accessToken,
      key: true,
      body: { name: 'Rajesh A', mobile: '9826100012', role: 'city_staff', plantIds: [] },
    });
    expect(invited.status).toBe(201);
    clock.advance(MIN);
    await call('POST', '/v1/auth/request-code', { body: { mobile: '9826100012' } });
    const choice = await call('POST', '/v1/auth/verify', {
      body: { mobile: '9826100012', code: '123456', deviceId: DEV },
    });
    expect([choice.status, choice.body.code]).toEqual([409, 'TENANT_CHOICE_REQUIRED']);
    expect(choice.body.details).toEqual([
      { tenantId: ids.tenant, tenantName: 'Agrawal Group' },
      { tenantId: t.tenantId, tenantName: 'Bansal Metals' },
    ]);
    const ok = await call('POST', '/v1/auth/verify', {
      body: { mobile: '9826100012', code: '123456', deviceId: DEV, tenantId: t.tenantId },
    });
    expect(ok.status).toBe(200);
    const me = await call('GET', '/v1/me', { token: ok.body.accessToken });
    expect(me.body.tenant).toEqual({ id: t.tenantId, name: 'Bansal Metals' });
  });

  it('refresh: rotation, grace, reuse revoke-all, device binding, access expiry', async () => {
    const p1 = await signIn('9826100012');
    const refresh = (refreshToken: string, deviceId = DEV) =>
      call('POST', '/v1/auth/refresh', { body: { refreshToken, deviceId } });
    expect((await refresh(p1.refreshToken, DEV2)).status).toBe(401);
    const r1 = await refresh(p1.refreshToken);
    expect(r1.status).toBe(200);
    clock.advance(10_000);
    const r1b = await refresh(p1.refreshToken);
    expect(r1b.body).toEqual(r1.body); // identical retry within 30 s
    clock.advance(20_000);
    const reuse = await refresh(p1.refreshToken);
    expect([reuse.status, reuse.body.code]).toEqual([401, 'UNAUTHENTICATED']);
    expect((await refresh(r1.body.refreshToken)).status).toBe(401); // newer token revoked too

    const p2 = await signIn('9826100013');
    clock.advance(15 * MIN);
    expect((await call('GET', '/v1/me', { token: p2.accessToken })).status).toBe(401);
    const r2 = await refresh(p2.refreshToken);
    expect(r2.status).toBe(200);
    expect((await call('GET', '/v1/me', { token: r2.body.accessToken })).status).toBe(200);

    expect(
      (await call('POST', '/v1/auth/sign-out', { body: { refreshToken: r2.body.refreshToken } }))
        .status,
    ).toBe(204);
    expect((await refresh(r2.body.refreshToken)).status).toBe(401);
    clock.advance(61 * 24 * 60 * MIN);
    const p3 = await signIn('9826100014');
    clock.advance(60 * 24 * 60 * MIN);
    expect((await refresh(p3.refreshToken)).status).toBe(401); // 60-day expiry
  });
});

describe('pipeline', () => {
  it('401 without token, 403 by policy, deactivated token 401', async () => {
    const none = await call('GET', '/v1/me');
    expect(none.status).toBe(401);
    expect(Object.keys(none.body).sort()).toEqual(['code', 'message']);
    expect((await call('GET', '/v1/users', { token: await as(ids.users.ravi) })).body.code).toBe(
      'FORBIDDEN',
    );
    const priya = await as(ids.users.priya);
    await call('POST', `/v1/users/${ids.users.priya}/deactivate`, {
      token: await as(ids.users.rajesh),
    });
    expect((await call('GET', '/v1/me', { token: priya })).status).toBe(401);
  });

  it('idempotency: replay, missing key, key reused on another route', async () => {
    const owner = await as(ids.users.rajesh);
    const body = { companyId: ids.companies.VSL, name: 'Urla II', location: 'Raipur' };
    const a = await call('POST', '/v1/plants', { token: owner, key: 'same', body });
    const b = await call('POST', '/v1/plants', { token: owner, key: 'same', body });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(a.headers['idempotent-replay']).toBeUndefined();
    const list = await call('GET', `/v1/plants?companyId=${ids.companies.VSL}`, { token: owner });
    expect(list.body).toHaveLength(2);
    const noKey = await call('POST', '/v1/plants', { token: owner, body });
    expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const other = await call('POST', '/v1/companies', {
      token: owner,
      key: 'same',
      body: { code: 'ZZ', name: 'Z', gstin: null, orderPrefix: 'SO-Z' },
    });
    expect([other.status, other.body.code]).toEqual([422, 'VALIDATION']);
  });

  it('422 details are { path, message }[]', async () => {
    const res = await call('PATCH', '/v1/me/preferences', {
      token: await as(ids.users.ravi),
      body: { unitBasis: 'lb' },
    });
    expect(res.status).toBe(422);
    expect(res.body.details[0]).toMatchObject({ path: ['unitBasis'] });
    expect(typeof res.body.details[0].message).toBe('string');
  });
});

describe('org', () => {
  it('company scope by role', async () => {
    const owner = await call('GET', '/v1/companies', { token: await as(ids.users.rajesh) });
    expect(owner.body.map((c: unknown) => companySchema.parse(c).code)).toEqual([
      'AIP',
      'VSL',
      'KRM',
      'NAP',
    ]);
    for (const u of [ids.users.ravi, ids.users.kiran]) {
      const res = await call('GET', '/v1/companies', { token: await as(u) });
      expect(res.body.map((c: { code: string }) => c.code)).toEqual(['AIP']);
    }
    const ravi = await as(ids.users.ravi);
    expect((await call('GET', `/v1/companies/${ids.companies.KRM}`, { token: ravi })).status).toBe(
      404,
    );
    expect((await call('GET', `/v1/companies/${ids.companies.AIP}`, { token: ravi })).status).toBe(
      200,
    );
    expect(
      (await call('GET', `/v1/plants?companyId=${ids.companies.KRM}`, { token: ravi })).body,
    ).toEqual([]);
    expect((await call('GET', `/v1/plants/${ids.plants.borai}`, { token: ravi })).status).toBe(404);
    const own = await call('GET', `/v1/plants/${ids.plants.siltara}`, { token: ravi });
    expect(plantSchema.parse(own.body).name).toBe('Siltara');
    expect((await call('GET', '/v1/plants?companyId=bad', { token: ravi })).status).toBe(422);
  });

  it('create/patch companies: duplicate code, STALE, version bump, 403, cross-tenant 404', async () => {
    const owner = await as(ids.users.rajesh);
    const dup = await call('POST', '/v1/companies', {
      token: owner,
      key: true,
      body: { code: 'AIP', name: 'Dup', gstin: null, orderPrefix: 'SO-D' },
    });
    expect([dup.status, dup.body.code, dup.body.details[0].path]).toEqual([
      422,
      'VALIDATION',
      ['code'],
    ]);
    const stalePatch = await call('PATCH', `/v1/companies/${ids.companies.AIP}`, {
      token: owner,
      body: { name: 'X', version: 7 },
    });
    expect([stalePatch.status, stalePatch.body.code]).toEqual([409, 'STALE']);
    const ok = await call('PATCH', `/v1/companies/${ids.companies.NAP}`, {
      token: owner,
      body: { active: false, version: 1 },
    });
    expect(ok.body).toMatchObject({ active: false, version: 2 });
    const codeClash = await call('PATCH', `/v1/companies/${ids.companies.NAP}`, {
      token: owner,
      body: { code: 'VSL', version: 2 },
    });
    expect(codeClash.body.details[0].path).toEqual(['code']);
    const city = await call('POST', '/v1/companies', {
      token: await as(ids.users.priya),
      key: true,
      body: { code: 'QQ', name: 'Q', gstin: null, orderPrefix: 'SO-Q' },
    });
    expect(city.status).toBe(403);

    const t = await api.fixtures.createTenant('Other');
    const foreign = await call('GET', `/v1/companies/${t.companyId}`, { token: owner });
    const random = await call('GET', `/v1/companies/${RANDOM_ID}`, { token: owner });
    expect(foreign).toEqual(random);
    expect(foreign.status).toBe(404);
    const foreignPatch = await call('PATCH', `/v1/companies/${t.companyId}`, {
      token: owner,
      body: { name: 'Hack', version: 1 },
    });
    expect(foreignPatch.status).toBe(404);
    const plantUnderForeign = await call('POST', '/v1/plants', {
      token: owner,
      key: true,
      body: { companyId: t.companyId, name: 'P', location: 'L' },
    });
    expect(plantUnderForeign.status).toBe(404);
  });

  it('patch plant and activity log', async () => {
    const owner = await as(ids.users.rajesh);
    const res = await call('PATCH', `/v1/plants/${ids.plants.urla}`, {
      token: owner,
      body: { location: 'Raipur East', version: 1 },
    });
    expect(res.body).toMatchObject({ location: 'Raipur East', version: 2 });
    expect(
      (await call('PATCH', `/v1/plants/${ids.plants.urla}`, { token: owner, body: { version: 1 } }))
        .status,
    ).toBe(409);
  });
});

describe('users', () => {
  const invite = (token: string, body: object) =>
    call('POST', '/v1/users', { token, key: true, body });

  it('invite rules', async () => {
    const owner = await as(ids.users.rajesh);
    const ok = await invite(owner, {
      name: 'New Sup',
      mobile: '9826100050',
      role: 'supervisor',
      plantIds: [ids.plants.urla],
    });
    expect(ok.status).toBe(201);
    expect(userSchema.parse(ok.body).status).toBe('invited');
    for (const plantIds of [[], [ids.plants.urla, ids.plants.tilda]]) {
      const bad = await invite(owner, {
        name: 'S',
        mobile: '9826100051',
        role: 'supervisor',
        plantIds,
      });
      expect([bad.status, bad.body.code]).toEqual([422, 'PLANT_RULE']);
    }
    const ph = await invite(owner, {
      name: 'PH',
      mobile: '9826100052',
      role: 'plant_head',
      plantIds: [ids.plants.urla, ids.plants.tilda],
    });
    expect(ph.status).toBe(201);
    const cs = await invite(owner, {
      name: 'CS',
      mobile: '9826100053',
      role: 'city_staff',
      plantIds: [ids.plants.urla],
    });
    expect(cs.body.code).toBe('PLANT_RULE');
    const exists = await invite(owner, {
      name: 'Priya',
      mobile: '09826100013',
      role: 'city_staff',
      plantIds: [],
    });
    expect([exists.status, exists.body.code]).toEqual([409, 'MOBILE_EXISTS']);
    const norm = await invite(owner, {
      name: 'N',
      mobile: '+91 98261 00099',
      role: 'city_staff',
      plantIds: [],
    });
    expect(norm.body.mobile).toBe('+919826100099');
    const t = await api.fixtures.createTenant('Other');
    const foreign = await invite(owner, {
      name: 'F',
      mobile: '9826100054',
      role: 'supervisor',
      plantIds: [t.plantId],
    });
    expect(foreign.status).toBe(404);
  });

  it('role change clears plants; last owner protection', async () => {
    const owner = await as(ids.users.rajesh);
    const ravi = await call('PATCH', `/v1/users/${ids.users.ravi}`, {
      token: owner,
      body: { role: 'city_staff', plantIds: [], version: 1 },
    });
    expect(ravi.body).toMatchObject({ role: 'city_staff', plantIds: [], version: 2 });
    const raviCompanies = await call('GET', '/v1/companies', { token: await as(ids.users.ravi) });
    expect(raviCompanies.body).toHaveLength(4);

    const self = await call('POST', `/v1/users/${ids.users.rajesh}/deactivate`, { token: owner });
    expect([self.status, self.body.code]).toEqual([409, 'LAST_OWNER']);
    const demote = await call('PATCH', `/v1/users/${ids.users.rajesh}`, {
      token: owner,
      body: { role: 'city_staff', version: 1 },
    });
    expect(demote.body.code).toBe('LAST_OWNER');
    await invite(owner, {
      name: 'Second Owner',
      mobile: '9826100060',
      role: 'owner',
      plantIds: [],
    });
    const demoted = await call('PATCH', `/v1/users/${ids.users.rajesh}`, {
      token: owner,
      body: { role: 'city_staff', version: 1 },
    });
    expect(demoted.body).toMatchObject({ role: 'city_staff', plantIds: [] });
  });

  it('deactivate revokes refresh; reactivate', async () => {
    const owner = await as(ids.users.rajesh);
    const priya = await signIn('9826100013');
    const d = await call('POST', `/v1/users/${ids.users.priya}/deactivate`, { token: owner });
    expect(d.body).toMatchObject({ active: false, status: 'inactive' });
    const r = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: priya.refreshToken, deviceId: DEV },
    });
    expect(r.status).toBe(401);
    const re = await call('POST', `/v1/users/${ids.users.priya}/reactivate`, { token: owner });
    expect(re.body).toMatchObject({ active: true, status: 'active' });
    expect((await call('POST', `/v1/users/${RANDOM_ID}/reactivate`, { token: owner })).status).toBe(
      404,
    );
  });
});

describe('me, meta, settings, redaction', () => {
  it('preferences persist across sign-in', async () => {
    const p = await signIn('9826100014');
    const patched = await call('PATCH', '/v1/me/preferences', {
      token: p.accessToken,
      body: { unitBasis: 'kg' },
    });
    expect(meSchema.parse(patched.body).preferences.unitBasis).toBe('kg');
    const again = await as(ids.users.ravi);
    expect((await call('GET', '/v1/me', { token: again })).body.preferences).toEqual({
      unitBasis: 'kg',
    });
  });

  it('meta', async () => {
    const res = await call('GET', '/v1/meta');
    expect(res.body).toEqual({
      minSupportedVersion: '1.0.0',
      serverTime: '2026-11-03T04:30:00.000Z',
    });
  });

  it('settings', async () => {
    const owner = await as(ids.users.rajesh);
    expect((await call('GET', '/v1/settings', { token: owner })).body).toEqual(
      DEFAULT_TENANT_SETTINGS,
    );
    const p = await call('PATCH', '/v1/settings', {
      token: owner,
      body: { completionToleranceKg: 500 },
    });
    expect(p.body.completionToleranceKg).toBe(500);
    expect(
      (await call('GET', '/v1/settings', { token: await as(ids.users.ravi) })).body
        .completionToleranceKg,
    ).toBe(500);
    expect(
      (await call('PATCH', '/v1/settings', { token: owner, body: { externalUnitBasis: 'lb' } }))
        .status,
    ).toBe(422);
    expect((await call('PATCH', '/v1/settings', { token: owner, body: [] })).status).toBe(422);
    expect(
      (await call('PATCH', '/v1/settings', { token: await as(ids.users.priya), body: {} })).status,
    ).toBe(403);
    const t = await api.fixtures.createTenant('Fresh');
    const fresh = await signIn(t.ownerMobile);
    expect((await call('GET', '/v1/settings', { token: fresh.accessToken })).body).toEqual(
      DEFAULT_TENANT_SETTINGS,
    );
  });
});
