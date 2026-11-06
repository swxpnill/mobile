import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { meSchema, plantSchema, userSchema, validationDetailsSchema } from '@tonnage/shared';
import {
  COMPANY,
  PEOPLE,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  newKey,
  tokenFor,
  useTarget,
} from '../harness.ts';

const plantBody = { companyId: COMPANY.VSL, name: 'Urla II', location: 'Raipur' };

export function register(factory: TargetFactory): void {
  describe('contract: pipeline', () => {
    const target = useTarget(factory);

    it('no token → 401 UNAUTHENTICATED with body exactly { code, message }', async () => {
      const res = await call(target(), 'GET', '/v1/me');
      expectError(res, 401, 'UNAUTHENTICATED');
      expect(Object.keys(res.body as object).sort()).toEqual(['code', 'message']);
    });

    it('a malformed or forged token → 401 UNAUTHENTICATED', async () => {
      const t = target();
      expectError(await call(t, 'GET', '/v1/me', { token: 'not-a-token' }), 401, 'UNAUTHENTICATED');
      const real = await tokenFor(t, PEOPLE.rajesh);
      const forged = `${real.slice(0, -4)}${real.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
      expectError(await call(t, 'GET', '/v1/me', { token: forged }), 401, 'UNAUTHENTICATED');
    });

    it('Review Focus 4: deactivate Priya, her existing access token → 401 on next request', async () => {
      const t = target();
      const priya = await tokenFor(t, PEOPLE.priya);
      expectOk(await call(t, 'GET', '/v1/me', { token: priya }), meSchema);
      const owner = await tokenFor(t, PEOPLE.rajesh);
      expectOk(
        await call(t, 'POST', `/v1/users/${PEOPLE.priya.id}/deactivate`, { token: owner }),
        userSchema,
      );
      expectError(await call(t, 'GET', '/v1/me', { token: priya }), 401, 'UNAUTHENTICATED');
    });

    it('supervisor GET /v1/users → 403 FORBIDDEN', async () => {
      const t = target();
      const ravi = await tokenFor(t, PEOPLE.ravi);
      expectError(await call(t, 'GET', '/v1/users', { token: ravi }), 403, 'FORBIDDEN');
    });

    it('idempotent POST /v1/plants replayed with same key → same body, idempotent-replay: true, one plant created', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const key = newKey();
      const first = await call(t, 'POST', '/v1/plants', {
        token: owner,
        idempotencyKey: key,
        body: plantBody,
      });
      const replay = await call(t, 'POST', '/v1/plants', {
        token: owner,
        idempotencyKey: key,
        body: plantBody,
      });
      const created = expectOk(first, plantSchema, 201);
      expect(expectOk(replay, plantSchema, 201)).toEqual(created);
      expect(first.headers['idempotent-replay']).toBeUndefined();
      expect(replay.headers['idempotent-replay']).toBe('true');
      const list = expectOk(
        await call(t, 'GET', `/v1/plants?companyId=${COMPANY.VSL}`, { token: owner }),
        z.array(plantSchema),
      );
      expect(list.filter((p) => p.name === 'Urla II')).toHaveLength(1);
    });

    it('idempotency keys belong to the user: another user with the same key gets their own result', async () => {
      const t = target();
      const key = newKey();
      const rajesh = await tokenFor(t, PEOPLE.rajesh);
      const a = expectOk(
        await call(t, 'POST', '/v1/plants', {
          token: rajesh,
          idempotencyKey: key,
          body: plantBody,
        }),
        plantSchema,
        201,
      );
      // A second owner, invited and signed in, reusing the same key, must not see Rajesh's response.
      const second = expectOk(
        await call(t, 'POST', '/v1/users', {
          token: rajesh,
          idempotencyKey: newKey(),
          body: { name: 'Second Owner', mobile: '9826100060', role: 'owner', plantIds: [] },
        }),
        userSchema,
        201,
      );
      const other = await tokenFor(t, second);
      const res = await call(t, 'POST', '/v1/plants', {
        token: other,
        idempotencyKey: key,
        body: { ...plantBody, name: 'Urla III' },
      });
      const b = expectOk(res, plantSchema, 201);
      expect(b.id).not.toBe(a.id);
      expect(res.headers['idempotent-replay']).toBeUndefined();
    });

    it('idempotent POST without key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      expectError(
        await call(t, 'POST', '/v1/plants', { token: owner, body: plantBody }),
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    });

    it('same key reused on a different route → 422 VALIDATION on idempotency-key', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const key = newKey();
      expectOk(
        await call(t, 'POST', '/v1/plants', { token: owner, idempotencyKey: key, body: plantBody }),
        plantSchema,
        201,
      );
      const err = expectError(
        await call(t, 'POST', '/v1/companies', {
          token: owner,
          idempotencyKey: key,
          body: { code: 'ZZ', name: 'Z Steels', gstin: null, orderPrefix: 'SO-ZZ' },
        }),
        422,
        'VALIDATION',
      );
      expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['idempotency-key']);
    });

    it('two concurrent same-key POSTs → one plant; the other gets 409 IDEMPOTENCY_IN_PROGRESS or the replay', async () => {
      // Which of the two outcomes happens depends on timing: the second request either finds the
      // first still running (409) or already finished (replay). Both are correct; a second plant
      // never is. A serial target (the mock) always takes the replay path.
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const key = newKey();
      const send = () =>
        call(t, 'POST', '/v1/plants', { token: owner, idempotencyKey: key, body: plantBody });
      const [a, b] = await Promise.all([send(), send()]);
      const [won, other] =
        a.status === 201 && a.headers['idempotent-replay'] === undefined ? [a, b] : [b, a];
      const created = expectOk(won, plantSchema, 201);
      expect(won.headers['idempotent-replay']).toBeUndefined();
      if (other.status === 409) {
        expectError(other, 409, 'IDEMPOTENCY_IN_PROGRESS');
      } else {
        expect(expectOk(other, plantSchema, 201)).toEqual(created);
        expect(other.headers['idempotent-replay']).toBe('true');
      }
      const list = expectOk(
        await call(t, 'GET', `/v1/plants?companyId=${COMPANY.VSL}`, { token: owner }),
        z.array(plantSchema),
      );
      expect(list.filter((p) => p.name === 'Urla II')).toHaveLength(1);
    });

    it('unknown route → 404 NOT_FOUND, with or without a token', async () => {
      const t = target();
      expectError(await call(t, 'GET', '/v1/nope'), 404, 'NOT_FOUND');
      const owner = await tokenFor(t, PEOPLE.rajesh);
      expectError(await call(t, 'GET', '/v1/nope', { token: owner }), 404, 'NOT_FOUND');
      expectError(await call(t, 'DELETE', '/v1/companies', { token: owner }), 404, 'NOT_FOUND');
    });

    it('authentication is checked before the body: a bad body without a token → 401, not 422', async () => {
      const t = target();
      expectError(
        await call(t, 'PATCH', '/v1/me/preferences', { body: { unitBasis: 'lb' } }),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('422 VALIDATION details are a list of { path, message }', async () => {
      const t = target();
      const ravi = await tokenFor(t, PEOPLE.ravi);
      const err = expectError(
        await call(t, 'PATCH', '/v1/me/preferences', { token: ravi, body: { unitBasis: 'lb' } }),
        422,
        'VALIDATION',
      );
      expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['unitBasis']);
    });
  });
}
