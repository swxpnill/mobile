import { describe, expect, it } from 'vitest';
import {
  SAMPLE_WORLD,
  meSchema,
  requestCodeResponseSchema,
  tenantChoiceDetailsSchema,
  tokenPairSchema,
  userSchema,
  validationDetailsSchema,
} from '@tonnage/shared';
import {
  DAY,
  DEV_CODE,
  DEVICE_A,
  DEVICE_B,
  MINUTE,
  PEOPLE,
  SECOND,
  type ContractTarget,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  expectSameResponse,
  newKey,
  signIn,
  tokenFor,
  useTarget,
} from '../harness.ts';

const requestCode = (t: ContractTarget, mobile: string) =>
  call(t, 'POST', '/v1/auth/request-code', { body: { mobile } });
const verify = (t: ContractTarget, mobile: string, code = DEV_CODE, extra: object = {}) =>
  call(t, 'POST', '/v1/auth/verify', { body: { mobile, code, deviceId: DEVICE_A, ...extra } });
const refresh = (t: ContractTarget, refreshToken: string, deviceId = DEVICE_A) =>
  call(t, 'POST', '/v1/auth/refresh', { body: { refreshToken, deviceId } });

export function register(factory: TargetFactory): void {
  describe('contract: auth', () => {
    const target = useTarget(factory);

    describe('request-code', () => {
      it('same 200 { resendAfterSeconds: 30 } for known and unknown numbers', async () => {
        const t = target();
        const known = await requestCode(t, PEOPLE.rajesh.mobile);
        const unknown = await requestCode(t, '9999999999');
        expect(expectOk(known, requestCodeResponseSchema)).toEqual({ resendAfterSeconds: 30 });
        expectSameResponse(unknown, known); // no way to tell them apart
      });

      it('a number that is not a valid Indian mobile → 422 VALIDATION on mobile', async () => {
        const err = expectError(await requestCode(target(), '12345'), 422, 'VALIDATION');
        expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['mobile']);
      });

      it('resend within 30 s → 429 OTP_RESEND_TOO_SOON; after 30 s → 200', async () => {
        const t = target();
        await requestCode(t, PEOPLE.rajesh.mobile);
        t.clock.advance(29 * SECOND);
        expectError(await requestCode(t, PEOPLE.rajesh.mobile), 429, 'OTP_RESEND_TOO_SOON');
        t.clock.advance(1 * SECOND);
        expectOk(await requestCode(t, PEOPLE.rajesh.mobile), requestCodeResponseSchema);
      });
    });

    describe('verify', () => {
      it('verify 123456 → token pair; GET /v1/me with it → Rajesh, role owner', async () => {
        const t = target();
        const pair = await signIn(t, PEOPLE.rajesh.mobile);
        const me = expectOk(await call(t, 'GET', '/v1/me', { token: pair.accessToken }), meSchema);
        expect(me).toMatchObject({ id: PEOPLE.rajesh.id, name: 'Rajesh Agrawal', role: 'owner' });
      });

      it('wrong code → 401 OTP_INVALID; 5 wrong → 429 OTP_LOCKED even for 123456; after 15 min works', async () => {
        const t = target();
        const mobile = PEOPLE.rajesh.mobile;
        await requestCode(t, mobile);
        for (let i = 1; i <= 4; i++)
          expectError(await verify(t, mobile, '000000'), 401, 'OTP_INVALID');
        expectError(await verify(t, mobile, '000000'), 429, 'OTP_LOCKED');
        expectError(await verify(t, mobile), 429, 'OTP_LOCKED');
        expectError(await requestCode(t, mobile), 429, 'OTP_LOCKED');
        t.clock.advance(15 * MINUTE - SECOND);
        expectError(await requestCode(t, mobile), 429, 'OTP_LOCKED');
        t.clock.advance(SECOND);
        await signIn(t, mobile);
      });

      it('challenge older than 5 min → 401 OTP_EXPIRED', async () => {
        const t = target();
        await requestCode(t, PEOPLE.rajesh.mobile);
        t.clock.advance(5 * MINUTE);
        expectError(await verify(t, PEOPLE.rajesh.mobile), 401, 'OTP_EXPIRED');
      });

      it('code just inside 5 min still works', async () => {
        const t = target();
        await requestCode(t, PEOPLE.rajesh.mobile);
        t.clock.advance(5 * MINUTE - SECOND);
        expectOk(await verify(t, PEOPLE.rajesh.mobile), tokenPairSchema);
      });

      it('consumed code reused → 401 OTP_INVALID', async () => {
        const t = target();
        await signIn(t, PEOPLE.rajesh.mobile);
        expectError(await verify(t, PEOPLE.rajesh.mobile), 401, 'OTP_INVALID');
      });

      it('verify for an unknown number → 401 OTP_INVALID (no enumeration)', async () => {
        const t = target();
        await requestCode(t, '9999999999');
        expectError(await verify(t, '9999999999'), 401, 'OTP_INVALID');
      });

      it('deactivated user → verify 401 OTP_INVALID', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectOk(
          await call(t, 'POST', `/v1/users/${PEOPLE.amit.id}/deactivate`, { token: owner }),
          userSchema,
        );
        await requestCode(t, PEOPLE.amit.mobile);
        expectError(await verify(t, PEOPLE.amit.mobile), 401, 'OTP_INVALID');
      });

      it('mobile in two tenants → 409 TENANT_CHOICE_REQUIRED with both tenant names; with tenantId → 200', async () => {
        const t = target();
        const other = await t.fixtures.createTenant('Bansal Metals');
        const otherOwner = await tokenFor(t, { mobile: other.ownerMobile });
        expectOk(
          await call(t, 'POST', '/v1/users', {
            token: otherOwner,
            idempotencyKey: newKey(),
            body: {
              name: 'Rajesh A',
              mobile: PEOPLE.rajesh.mobile,
              role: 'city_staff',
              plantIds: [],
            },
          }),
          userSchema,
          201,
        );

        await requestCode(t, PEOPLE.rajesh.mobile);
        const err = expectError(
          await verify(t, PEOPLE.rajesh.mobile),
          409,
          'TENANT_CHOICE_REQUIRED',
        );
        expect(tenantChoiceDetailsSchema.parse(err.details)).toEqual([
          { tenantId: SAMPLE_WORLD.tenant.id, tenantName: 'Agrawal Group' },
          { tenantId: other.tenantId, tenantName: 'Bansal Metals' },
        ]);

        const pair = expectOk(
          await verify(t, PEOPLE.rajesh.mobile, DEV_CODE, { tenantId: other.tenantId }),
          tokenPairSchema,
        );
        const me = expectOk(await call(t, 'GET', '/v1/me', { token: pair.accessToken }), meSchema);
        expect(me.tenant).toEqual({ id: other.tenantId, name: 'Bansal Metals' });
        expect(me.role).toBe('city_staff');
      });
    });

    describe('tokens', () => {
      it('refresh rotates: new pair works; old token then 401 after 30 s', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile);
        const p2 = expectOk(await refresh(t, p1.refreshToken), tokenPairSchema);
        expect(p2.refreshToken).not.toBe(p1.refreshToken);
        expectOk(await call(t, 'GET', '/v1/me', { token: p2.accessToken }), meSchema);
        t.clock.advance(31 * SECOND);
        expectError(await refresh(t, p1.refreshToken), 401, 'UNAUTHENTICATED');
      });

      it('Review Focus 3: same old refresh twice within 30 s → identical new pair', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile);
        const first = expectOk(await refresh(t, p1.refreshToken), tokenPairSchema);
        t.clock.advance(10 * SECOND);
        const retry = expectOk(await refresh(t, p1.refreshToken), tokenPairSchema);
        expect(retry).toEqual(first);
        expectOk(await call(t, 'GET', '/v1/me', { token: retry.accessToken }), meSchema);
      });

      it('Review Focus 3: reuse after grace → 401 and the newer refresh token is also revoked', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile);
        const p2 = expectOk(await refresh(t, p1.refreshToken), tokenPairSchema);
        t.clock.advance(30 * SECOND);
        expectError(await refresh(t, p1.refreshToken), 401, 'UNAUTHENTICATED');
        expectError(await refresh(t, p2.refreshToken), 401, 'UNAUTHENTICATED');
      });

      it('reuse detection revokes the user’s other devices too, not other users', async () => {
        const t = target();
        const phone = await signIn(t, PEOPLE.rajesh.mobile, DEVICE_A);
        const tablet = await signIn(t, PEOPLE.rajesh.mobile, DEVICE_B);
        const priya = await signIn(t, PEOPLE.priya.mobile, DEVICE_A);
        expectOk(await refresh(t, phone.refreshToken), tokenPairSchema);
        t.clock.advance(31 * SECOND);
        expectError(await refresh(t, phone.refreshToken), 401, 'UNAUTHENTICATED');
        expectError(await refresh(t, tablet.refreshToken, DEVICE_B), 401, 'UNAUTHENTICATED');
        expectOk(await refresh(t, priya.refreshToken), tokenPairSchema);
      });

      it('refresh from a different deviceId → 401', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile, DEVICE_A);
        expectError(await refresh(t, p1.refreshToken, DEVICE_B), 401, 'UNAUTHENTICATED');
      });

      it('access token rejected after 15 min → 401 UNAUTHENTICATED; refresh still works', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile);
        t.clock.advance(15 * MINUTE - SECOND);
        expectOk(await call(t, 'GET', '/v1/me', { token: p1.accessToken }), meSchema);
        t.clock.advance(SECOND);
        expectError(
          await call(t, 'GET', '/v1/me', { token: p1.accessToken }),
          401,
          'UNAUTHENTICATED',
        );
        const p2 = expectOk(await refresh(t, p1.refreshToken), tokenPairSchema);
        expectOk(await call(t, 'GET', '/v1/me', { token: p2.accessToken }), meSchema);
      });

      it('refresh token lasts 60 days from its last use (rolling)', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile);
        t.clock.advance(59 * DAY);
        const p2 = expectOk(await refresh(t, p1.refreshToken), tokenPairSchema);
        t.clock.advance(59 * DAY);
        const p3 = expectOk(await refresh(t, p2.refreshToken), tokenPairSchema);
        t.clock.advance(60 * DAY);
        expectError(await refresh(t, p3.refreshToken), 401, 'UNAUTHENTICATED');
      });

      it('sign-out → 204; that refresh token no longer works', async () => {
        const t = target();
        const p1 = await signIn(t, PEOPLE.rajesh.mobile);
        const out = await call(t, 'POST', '/v1/auth/sign-out', {
          body: { refreshToken: p1.refreshToken },
        });
        expect(out.status).toBe(204);
        expectError(await refresh(t, p1.refreshToken), 401, 'UNAUTHENTICATED');
      });
    });
  });
}
