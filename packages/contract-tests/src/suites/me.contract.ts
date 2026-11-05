import { describe, expect, it } from 'vitest';
import { meSchema, validationDetailsSchema } from '@tonnage/shared';
import {
  DEVICE_B,
  PEOPLE,
  PLANT,
  SECOND,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  signIn,
  tokenFor,
  useTarget,
} from '../harness.ts';

export function register(factory: TargetFactory): void {
  describe('contract: me', () => {
    const target = useTarget(factory);

    it('GET /v1/me shape matches meSchema; default unitBasis "mt"; tenant and plants included', async () => {
      const t = target();
      const owner = expectOk(
        await call(t, 'GET', '/v1/me', { token: await tokenFor(t, PEOPLE.rajesh) }),
        meSchema,
      );
      expect(owner).toMatchObject({
        id: PEOPLE.rajesh.id,
        mobile: '+919826100012',
        role: 'owner',
        plantIds: [],
        preferences: { unitBasis: 'mt' },
        tenant: { name: 'Agrawal Group' },
      });
      const ravi = expectOk(
        await call(t, 'GET', '/v1/me', { token: await tokenFor(t, PEOPLE.ravi) }),
        meSchema,
      );
      expect(ravi).toMatchObject({ role: 'supervisor', plantIds: [PLANT.siltara] });
    });

    it('PATCH /v1/me/preferences { unitBasis: "kg" } persists across sign-in; "lb" → 422', async () => {
      const t = target();
      const first = await tokenFor(t, PEOPLE.ravi);
      const patched = expectOk(
        await call(t, 'PATCH', '/v1/me/preferences', { token: first, body: { unitBasis: 'kg' } }),
        meSchema,
      );
      expect(patched.preferences).toEqual({ unitBasis: 'kg' });

      t.clock.advance(30 * SECOND);
      const again = await signIn(t, PEOPLE.ravi.mobile, DEVICE_B); // a different phone
      const me = expectOk(await call(t, 'GET', '/v1/me', { token: again.accessToken }), meSchema);
      expect(me.preferences).toEqual({ unitBasis: 'kg' });

      const err = expectError(
        await call(t, 'PATCH', '/v1/me/preferences', { token: first, body: { unitBasis: 'lb' } }),
        422,
        'VALIDATION',
      );
      expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['unitBasis']);
    });

    it('unit basis is per user: Ravi switching to kg leaves Rajesh on mt', async () => {
      const t = target();
      await call(t, 'PATCH', '/v1/me/preferences', {
        token: await tokenFor(t, PEOPLE.ravi),
        body: { unitBasis: 'kg' },
      });
      const owner = expectOk(
        await call(t, 'GET', '/v1/me', { token: await tokenFor(t, PEOPLE.rajesh) }),
        meSchema,
      );
      expect(owner.preferences.unitBasis).toBe('mt');
    });

    it('every role may read and set its own preferences', async () => {
      const t = target();
      for (const who of [PEOPLE.rajesh, PEOPLE.priya, PEOPLE.kiran, PEOPLE.ravi]) {
        expectOk(
          await call(t, 'PATCH', '/v1/me/preferences', {
            token: await tokenFor(t, who),
            body: { unitBasis: 'kg' },
          }),
          meSchema,
        );
      }
    });
  });
}
