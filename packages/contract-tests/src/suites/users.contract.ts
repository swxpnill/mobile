import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { companySchema, meSchema, userSchema, validationDetailsSchema } from '@tonnage/shared';
import {
  DEVICE_A,
  PEOPLE,
  PLANT,
  RANDOM_ID,
  type ContractTarget,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  newKey,
  signIn,
  tokenFor,
  useTarget,
} from '../harness.ts';

const users = z.array(userSchema);

const invite = (t: ContractTarget, token: string, body: object) =>
  call(t, 'POST', '/v1/users', { token, idempotencyKey: newKey(), body });

async function userById(t: ContractTarget, token: string, id: string) {
  const list = expectOk(await call(t, 'GET', '/v1/users', { token }), users);
  const u = list.find((x) => x.id === id);
  if (!u) throw new Error(`user ${id} not in list`);
  return u;
}

export function register(factory: TargetFactory): void {
  describe('contract: users', () => {
    const target = useTarget(factory);

    describe('invite and the plant rule', () => {
      it('invite supervisor with 1 plant → 201 status invited; 0 or 2 plants → 422 PLANT_RULE', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const ok = expectOk(
          await invite(t, owner, {
            name: 'Naveen Sahu',
            mobile: '9826100050',
            role: 'supervisor',
            plantIds: [PLANT.urla],
          }),
          userSchema,
          201,
        );
        expect(ok).toMatchObject({
          status: 'invited',
          active: true,
          plantIds: [PLANT.urla],
          version: 1,
        });
        for (const plantIds of [[], [PLANT.urla, PLANT.tilda]]) {
          expectError(
            await invite(t, owner, {
              name: 'S',
              mobile: '9826100051',
              role: 'supervisor',
              plantIds,
            }),
            422,
            'PLANT_RULE',
          );
        }
      });

      it('plant_head 2 plants ok, 0 plants → PLANT_RULE; city_staff or owner with a plant → 422 PLANT_RULE', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectOk(
          await invite(t, owner, {
            name: 'PH',
            mobile: '9826100052',
            role: 'plant_head',
            plantIds: [PLANT.urla, PLANT.tilda],
          }),
          userSchema,
          201,
        );
        expectError(
          await invite(t, owner, {
            name: 'PH0',
            mobile: '9826100055',
            role: 'plant_head',
            plantIds: [],
          }),
          422,
          'PLANT_RULE',
        );
        for (const role of ['city_staff', 'owner']) {
          expectError(
            await invite(t, owner, {
              name: 'X',
              mobile: '9826100053',
              role,
              plantIds: [PLANT.urla],
            }),
            422,
            'PLANT_RULE',
          );
        }
      });

      it('Review Focus 2: invite "09826100013" (Priya exists) → 409 MOBILE_EXISTS; "+91 98261 00099" stored as "+919826100099"', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        for (const mobile of ['09826100013', '9826100013', '+91 98261 00013', '919826100013']) {
          expectError(
            await invite(t, owner, {
              name: 'Priya again',
              mobile,
              role: 'city_staff',
              plantIds: [],
            }),
            409,
            'MOBILE_EXISTS',
          );
        }
        const created = expectOk(
          await invite(t, owner, {
            name: 'Neha',
            mobile: '+91 98261 00099',
            role: 'city_staff',
            plantIds: [],
          }),
          userSchema,
          201,
        );
        expect(created.mobile).toBe('+919826100099');
      });

      it('Review Focus 2: every typed shape of a number signs in as the same user; bad numbers rejected', async () => {
        const t = target();
        for (const mobile of ['+91 98261 00012', '9826100012', '09826100012', '919826100012']) {
          const pair = await signIn(t, mobile);
          const me = expectOk(
            await call(t, 'GET', '/v1/me', { token: pair.accessToken }),
            meSchema,
          );
          expect(me).toMatchObject({ id: PEOPLE.rajesh.id, mobile: '+919826100012' });
        }
        const owner = await tokenFor(t, PEOPLE.rajesh);
        for (const mobile of ['12345', '5826012345']) {
          const err = expectError(
            await invite(t, owner, { name: 'Bad', mobile, role: 'city_staff', plantIds: [] }),
            422,
            'VALIDATION',
          );
          expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['mobile']);
        }
      });

      it('plantIds from another tenant → 404', async () => {
        const t = target();
        const other = await t.fixtures.createTenant('Other Group');
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectError(
          await invite(t, owner, {
            name: 'F',
            mobile: '9826100054',
            role: 'supervisor',
            plantIds: [other.plantId],
          }),
          404,
          'NOT_FOUND',
        );
      });

      it('city_staff cannot list or invite users → 403', async () => {
        const t = target();
        const priya = await tokenFor(t, PEOPLE.priya);
        expectError(await call(t, 'GET', '/v1/users', { token: priya }), 403, 'FORBIDDEN');
        expectError(
          await invite(t, priya, {
            name: 'X',
            mobile: '9826100056',
            role: 'city_staff',
            plantIds: [],
          }),
          403,
          'FORBIDDEN',
        );
      });
    });

    describe('roles and status', () => {
      it('change Ravi supervisor → city_staff with plantIds [] → plants cleared, he now sees all companies', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const before = await userById(t, owner, PEOPLE.ravi.id);
        const after = expectOk(
          await call(t, 'PATCH', `/v1/users/${PEOPLE.ravi.id}`, {
            token: owner,
            body: { role: 'city_staff', plantIds: [], version: before.version },
          }),
          userSchema,
        );
        expect(after).toMatchObject({
          role: 'city_staff',
          plantIds: [],
          version: before.version + 1,
        });
        const list = expectOk(
          await call(t, 'GET', '/v1/companies', { token: await tokenFor(t, PEOPLE.ravi) }),
          z.array(companySchema),
        );
        expect(list).toHaveLength(4);
      });

      it('role change that breaks the plant rule → 422 PLANT_RULE (supervisor → plant_head with no plants)', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectError(
          await call(t, 'PATCH', `/v1/users/${PEOPLE.ravi.id}`, {
            token: owner,
            body: { role: 'plant_head', plantIds: [], version: 1 },
          }),
          422,
          'PLANT_RULE',
        );
      });

      it('PATCH user with a stale version → 409 STALE', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectError(
          await call(t, 'PATCH', `/v1/users/${PEOPLE.ravi.id}`, {
            token: owner,
            body: { name: 'R', version: 9 },
          }),
          409,
          'STALE',
        );
      });

      it('Review Focus 1: Rajesh deactivates himself → 409 LAST_OWNER; demote → 409 LAST_OWNER; with a second owner, allowed', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectError(
          await call(t, 'POST', `/v1/users/${PEOPLE.rajesh.id}/deactivate`, { token: owner }),
          409,
          'LAST_OWNER',
        );
        expectError(
          await call(t, 'PATCH', `/v1/users/${PEOPLE.rajesh.id}`, {
            token: owner,
            body: { role: 'city_staff', version: 1 },
          }),
          409,
          'LAST_OWNER',
        );

        const second = expectOk(
          await invite(t, owner, {
            name: 'Sunita Agrawal',
            mobile: '9826100060',
            role: 'owner',
            plantIds: [],
          }),
          userSchema,
          201,
        );
        const demoted = expectOk(
          await call(t, 'PATCH', `/v1/users/${PEOPLE.rajesh.id}`, {
            token: owner,
            body: { role: 'city_staff', version: 1 },
          }),
          userSchema,
        );
        expect(demoted).toMatchObject({ role: 'city_staff', plantIds: [] });

        // Sunita is now the only owner, and is protected in turn.
        const sunita = await tokenFor(t, second);
        expectError(
          await call(t, 'POST', `/v1/users/${second.id}/deactivate`, { token: sunita }),
          409,
          'LAST_OWNER',
        );
      });

      it('Deepak status invited; after he signs in → active', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expect((await userById(t, owner, PEOPLE.deepak.id)).status).toBe('invited');
        await signIn(t, PEOPLE.deepak.mobile);
        expect((await userById(t, owner, PEOPLE.deepak.id)).status).toBe('active');
      });

      it('deactivate → inactive and refresh revoked; reactivate → active and can sign in again', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const priya = await signIn(t, PEOPLE.priya.mobile);
        const off = expectOk(
          await call(t, 'POST', `/v1/users/${PEOPLE.priya.id}/deactivate`, { token: owner }),
          userSchema,
        );
        expect(off).toMatchObject({ active: false, status: 'inactive' });
        expectError(
          await call(t, 'POST', '/v1/auth/refresh', {
            body: { refreshToken: priya.refreshToken, deviceId: DEVICE_A },
          }),
          401,
          'UNAUTHENTICATED',
        );
        const on = expectOk(
          await call(t, 'POST', `/v1/users/${PEOPLE.priya.id}/reactivate`, { token: owner }),
          userSchema,
        );
        expect(on).toMatchObject({ active: true, status: 'active' });
        expectOk(
          await call(t, 'GET', '/v1/me', {
            token: (await signIn(t, PEOPLE.priya.mobile)).accessToken,
          }),
          meSchema,
        );
      });

      it('deactivate or reactivate an unknown or foreign user → 404', async () => {
        const t = target();
        const other = await t.fixtures.createTenant('Other Group');
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expectError(
          await call(t, 'POST', `/v1/users/${RANDOM_ID}/deactivate`, { token: owner }),
          404,
          'NOT_FOUND',
        );
        const theirOwner = expectOk(
          await call(t, 'GET', '/v1/me', {
            token: await tokenFor(t, { mobile: other.ownerMobile }),
          }),
          meSchema,
        );
        expectError(
          await call(t, 'POST', `/v1/users/${theirOwner.id}/reactivate`, { token: owner }),
          404,
          'NOT_FOUND',
        );
      });
    });
  });
}
