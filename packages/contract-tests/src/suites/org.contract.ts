import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { companySchema, plantSchema, validationDetailsSchema } from '@tonnage/shared';
import {
  COMPANY,
  PEOPLE,
  PLANT,
  RANDOM_ID,
  type ContractTarget,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  newKey,
  tokenFor,
  useTarget,
} from '../harness.ts';

const companies = z.array(companySchema);
const plants = z.array(plantSchema);
const codes = (list: { code: string }[]) => list.map((c) => c.code).sort();

const createCompany = (t: ContractTarget, token: string, body: object) =>
  call(t, 'POST', '/v1/companies', { token, idempotencyKey: newKey(), body });

export function register(factory: TargetFactory): void {
  describe('contract: org', () => {
    const target = useTarget(factory);

    describe('companies', () => {
      it('owner lists 4 companies; Ravi (supervisor) and Kiran (plant head) list only AIP', async () => {
        const t = target();
        const all = expectOk(
          await call(t, 'GET', '/v1/companies', { token: await tokenFor(t, PEOPLE.rajesh) }),
          companies,
        );
        expect(codes(all)).toEqual(['AIP', 'KRM', 'NAP', 'VSL']);
        for (const who of [PEOPLE.ravi, PEOPLE.kiran]) {
          const mine = expectOk(
            await call(t, 'GET', '/v1/companies', { token: await tokenFor(t, who) }),
            companies,
          );
          expect(codes(mine)).toEqual(['AIP']);
        }
      });

      it('city staff list every company', async () => {
        const t = target();
        const list = expectOk(
          await call(t, 'GET', '/v1/companies', { token: await tokenFor(t, PEOPLE.priya) }),
          companies,
        );
        expect(list).toHaveLength(4);
      });

      it('owner creates a company → 201; it appears in the list with version 1', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const created = expectOk(
          await createCompany(t, owner, {
            code: 'SKS',
            name: 'Shakti Steels',
            gstin: '22AAACS1234A1Z5',
            orderPrefix: 'SO-SKS',
          }),
          companySchema,
          201,
        );
        expect(created).toMatchObject({ code: 'SKS', active: true, version: 1 });
        const list = expectOk(await call(t, 'GET', '/v1/companies', { token: owner }), companies);
        expect(codes(list)).toContain('SKS');
      });

      it('create company duplicate code → 422 VALIDATION details[0].path = ["code"]', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const err = expectError(
          await createCompany(t, owner, {
            code: 'AIP',
            name: 'Dup',
            gstin: null,
            orderPrefix: 'SO-D',
          }),
          422,
          'VALIDATION',
        );
        expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['code']);
      });

      it('invalid GSTIN → 422 VALIDATION on gstin', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const err = expectError(
          await createCompany(t, owner, {
            code: 'BAD',
            name: 'Bad',
            gstin: '22AAAC',
            orderPrefix: 'SO-B',
          }),
          422,
          'VALIDATION',
        );
        expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['gstin']);
      });

      it('PATCH stale version → 409 STALE; success returns version + 1', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const path = `/v1/companies/${COMPANY.AIP}`;
        const before = expectOk(await call(t, 'GET', path, { token: owner }), companySchema);
        expectError(
          await call(t, 'PATCH', path, {
            token: owner,
            body: { name: 'X', version: before.version + 5 },
          }),
          409,
          'STALE',
        );
        const after = expectOk(
          await call(t, 'PATCH', path, {
            token: owner,
            body: { name: 'Aarav Ispat Ltd', version: before.version },
          }),
          companySchema,
        );
        expect(after).toMatchObject({ name: 'Aarav Ispat Ltd', version: before.version + 1 });
        expectError(
          await call(t, 'PATCH', path, {
            token: owner,
            body: { name: 'Again', version: before.version },
          }),
          409,
          'STALE',
        );
      });

      it('PATCH to another company’s code → 422 VALIDATION on code', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const err = expectError(
          await call(t, 'PATCH', `/v1/companies/${COMPANY.NAP}`, {
            token: owner,
            body: { code: 'VSL', version: 1 },
          }),
          422,
          'VALIDATION',
        );
        expect(validationDetailsSchema.parse(err.details)[0]?.path).toEqual(['code']);
      });

      it('Review Focus 5: another tenant’s company id → GET/PATCH 404 NOT_FOUND, same body as a random uuid', async () => {
        const t = target();
        const other = await t.fixtures.createTenant('Other Group');
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const foreign = await call(t, 'GET', `/v1/companies/${other.companyId}`, { token: owner });
        const missing = await call(t, 'GET', `/v1/companies/${RANDOM_ID}`, { token: owner });
        expectError(foreign, 404, 'NOT_FOUND');
        expect(foreign).toEqual(missing);
        const patch = await call(t, 'PATCH', `/v1/companies/${other.companyId}`, {
          token: owner,
          body: { name: 'Taken over', version: 1 },
        });
        expectError(patch, 404, 'NOT_FOUND');
        expect(patch.body).toEqual(missing.body);
      });

      it('Review Focus 5: another tenant’s plant id → GET/PATCH 404; creating a plant under their company → 404', async () => {
        const t = target();
        const other = await t.fixtures.createTenant('Other Group');
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const missing = await call(t, 'GET', `/v1/plants/${RANDOM_ID}`, { token: owner });
        const foreign = await call(t, 'GET', `/v1/plants/${other.plantId}`, { token: owner });
        expectError(foreign, 404, 'NOT_FOUND');
        expect(foreign).toEqual(missing);
        expectError(
          await call(t, 'PATCH', `/v1/plants/${other.plantId}`, {
            token: owner,
            body: { name: 'X', version: 1 },
          }),
          404,
          'NOT_FOUND',
        );
        expectError(
          await call(t, 'POST', '/v1/plants', {
            token: owner,
            idempotencyKey: newKey(),
            body: { companyId: other.companyId, name: 'Sneaky', location: 'Raipur' },
          }),
          404,
          'NOT_FOUND',
        );
        // …and the other tenant still sees only its own company.
        const theirs = expectOk(
          await call(t, 'GET', '/v1/companies', {
            token: await tokenFor(t, { mobile: other.ownerMobile }),
          }),
          companies,
        );
        expect(codes(theirs)).toEqual(['TNT']);
      });

      it('city_staff POST /v1/companies → 403', async () => {
        const t = target();
        expectError(
          await createCompany(t, await tokenFor(t, PEOPLE.priya), {
            code: 'QQ',
            name: 'Q',
            gstin: null,
            orderPrefix: 'SO-Q',
          }),
          403,
          'FORBIDDEN',
        );
      });

      it('deactivate a company with no orders → 200 active false', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const res = expectOk(
          await call(t, 'PATCH', `/v1/companies/${COMPANY.NAP}`, {
            token: owner,
            body: { active: false, version: 1 },
          }),
          companySchema,
        );
        expect(res).toMatchObject({ active: false, version: 2 });
      });
    });

    describe('plants', () => {
      it('Ravi GET /v1/plants?companyId=<KRM> → []; GET /v1/plants/<Borai> → 404; own Siltara → 200', async () => {
        const t = target();
        const ravi = await tokenFor(t, PEOPLE.ravi);
        expect(
          expectOk(
            await call(t, 'GET', `/v1/plants?companyId=${COMPANY.KRM}`, { token: ravi }),
            plants,
          ),
        ).toEqual([]);
        expectError(
          await call(t, 'GET', `/v1/plants/${PLANT.borai}`, { token: ravi }),
          404,
          'NOT_FOUND',
        );
        expectError(
          await call(t, 'GET', `/v1/companies/${COMPANY.KRM}`, { token: ravi }),
          404,
          'NOT_FOUND',
        );
        const own = expectOk(
          await call(t, 'GET', `/v1/plants/${PLANT.siltara}`, { token: ravi }),
          plantSchema,
        );
        expect(own).toMatchObject({ name: 'Siltara', companyId: COMPANY.AIP });
      });

      it('owner lists every plant; companyId filter narrows; malformed companyId → 422', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        expect(expectOk(await call(t, 'GET', '/v1/plants', { token: owner }), plants)).toHaveLength(
          4,
        );
        const krm = expectOk(
          await call(t, 'GET', `/v1/plants?companyId=${COMPANY.KRM}`, { token: owner }),
          plants,
        );
        expect(krm.map((p) => p.name)).toEqual(['Borai']);
        expectError(
          await call(t, 'GET', '/v1/plants?companyId=bad', { token: owner }),
          422,
          'VALIDATION',
        );
      });

      it('owner creates and edits a plant; PATCH stale → 409', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const p = expectOk(
          await call(t, 'POST', '/v1/plants', {
            token: owner,
            idempotencyKey: newKey(),
            body: { companyId: COMPANY.KRM, name: 'Bhilai', location: 'Durg' },
          }),
          plantSchema,
          201,
        );
        expect(p).toMatchObject({ companyId: COMPANY.KRM, active: true, version: 1 });
        const edited = expectOk(
          await call(t, 'PATCH', `/v1/plants/${p.id}`, {
            token: owner,
            body: { location: 'Bhilai', version: 1 },
          }),
          plantSchema,
        );
        expect(edited).toMatchObject({ location: 'Bhilai', version: 2 });
        expectError(
          await call(t, 'PATCH', `/v1/plants/${p.id}`, {
            token: owner,
            body: { name: 'B', version: 1 },
          }),
          409,
          'STALE',
        );
      });

      it('city_staff and plant roles cannot create plants → 403', async () => {
        const t = target();
        for (const who of [PEOPLE.priya, PEOPLE.kiran, PEOPLE.ravi]) {
          expectError(
            await call(t, 'POST', '/v1/plants', {
              token: await tokenFor(t, who),
              idempotencyKey: newKey(),
              body: { companyId: COMPANY.AIP, name: 'X', location: 'Y' },
            }),
            403,
            'FORBIDDEN',
          );
        }
      });
    });
  });
}
