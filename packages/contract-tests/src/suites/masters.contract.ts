import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SAMPLE_MASTERS,
  partySchema,
  partySummarySchema,
  productSchema,
  validationDetailsSchema,
} from '@tonnage/shared';
import {
  COMPANY,
  PEOPLE,
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

const parties = z.array(partySummarySchema);
const products = z.array(productSchema);
const P = SAMPLE_MASTERS.ids.parties;

const broker = {
  type: 'broker',
  name: 'Sharma Steel Brokers',
  gstin: '22AABCS1429B1ZB',
  city: 'Raipur',
  defaultCommissionPerMt: 150,
  paymentTermsText: '',
  isSelfTransporter: false,
  contacts: [
    {
      name: 'Vinod Sharma',
      roleLabel: 'Owner',
      numbers: [
        { number: '98271 55012', label: 'Mobile', whatsapp: true },
        { number: '0771 402 1100', label: 'Office', whatsapp: false },
      ],
    },
  ],
  addresses: [],
};

const tmt32 = {
  category: 'TMT',
  grade: 'Fe500D',
  sizeLabel: '32 mm',
  conversionPerMt: 500,
  standardLengths: [{ value: 12, unit: 'm' }],
  companyIds: [COMPANY.AIP, COMPANY.KRM],
};

const post = (t: ContractTarget, token: string, path: string, body: object) =>
  call(t, 'POST', path, { token, idempotencyKey: newKey(), body });

const paths = (body: unknown) =>
  validationDetailsSchema.parse((body as { details: unknown }).details).map((d) => d.path);

export function register(factory: TargetFactory): void {
  describe('contract: masters', () => {
    const target = useTarget(factory);

    describe('parties', () => {
      it('owner creates a broker: 201, numbers normalised, detail round-trips', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const created = expectOk(await post(t, token, '/v1/parties', broker), partySchema, 201);
        expect(created).toMatchObject({ type: 'broker', defaultCommissionPerMt: 150, active: true, version: 1 });
        expect(created.contacts[0]?.numbers.map((n) => n.number)).toEqual(['+919827155012', '+917714021100']);
        expect(created.stats).toEqual({ openOrders: 0, pendingKg: 0, fyDispatchedKg: 0 });
        const read = expectOk(await call(t, 'GET', `/v1/parties/${created.id}`, { token }), partySchema);
        expect(read).toEqual(created);
      });

      it('the same GSTIN again → 409 GSTIN_EXISTS naming the other party', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.priya);
        const err = expectError(
          await post(t, token, '/v1/parties', { ...broker, name: 'Copy', gstin: '27AAKFS1234L1Z5' }),
          409,
          'GSTIN_EXISTS',
        );
        expect(err.details).toEqual({ partyId: P.shubham, name: 'Shubham Traders' });
      });

      it('a customer without a ship-to site → 422 at addresses', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const res = await post(t, token, '/v1/parties', {
          ...broker,
          type: 'customer',
          gstin: null,
          defaultCommissionPerMt: null,
          addresses: [{ kind: 'bill_to', label: 'Bill to', address: 'Raipur', isDefault: true }],
        });
        expectError(res, 422, 'VALIDATION');
        expect(paths(res.body)).toContainEqual(['addresses']);
      });

      it('plant head and supervisor have no access to parties (403, a role rule, not scope)', async () => {
        const t = target();
        for (const who of [PEOPLE.kiran, PEOPLE.ravi]) {
          expectError(await call(t, 'GET', '/v1/parties', { token: await tokenFor(t, who) }), 403, 'FORBIDDEN');
        }
      });

      it('list: by type, sorted by name; search by phone digits, GSTIN or contact name', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const customers = expectOk(await call(t, 'GET', '/v1/parties?type=customer', { token }), parties);
        expect(customers.map((p) => p.name)).toEqual([
          'Gupta Hardware',
          'Krishna Construction',
          'Patel Infra Projects',
          'Shubham Traders',
        ]);
        expect(customers.find((p) => p.id === P.shubham)).toMatchObject({ people: 2, numbers: 3, pendingKg: 0 });
        for (const q of ['98260 12345', '27aakfs', 'suresh']) {
          const found = expectOk(
            await call(t, 'GET', `/v1/parties?q=${encodeURIComponent(q)}`, { token }),
            parties,
          );
          expect(found.map((p) => p.name), q).toEqual(['Shubham Traders']);
        }
      });

      it('edit: version required, stale → 409; type cannot change; deactivate hides from active=true', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const current = expectOk(await call(t, 'GET', `/v1/parties/${P.mittal}`, { token }), partySchema);
        const body = { ...current, version: current.version, active: true, defaultCommissionPerMt: 130 };
        const updated = expectOk(
          await call(t, 'PATCH', `/v1/parties/${P.mittal}`, { token, body }),
          partySchema,
        );
        expect(updated).toMatchObject({ defaultCommissionPerMt: 130, version: current.version + 1 });
        expect(updated.contacts[0]?.id).toBe(current.contacts[0]?.id);
        expectError(await call(t, 'PATCH', `/v1/parties/${P.mittal}`, { token, body }), 409, 'STALE');
        const typeChange = await call(t, 'PATCH', `/v1/parties/${P.mittal}`, {
          token,
          body: { ...body, version: updated.version, type: 'transporter', defaultCommissionPerMt: null },
        });
        expectError(typeChange, 422, 'VALIDATION');
        expect(paths(typeChange.body)).toContainEqual(['type']);
        expectOk(
          await call(t, 'PATCH', `/v1/parties/${P.mittal}`, {
            token,
            body: { ...body, version: updated.version, active: false },
          }),
          partySchema,
        );
        const active = expectOk(await call(t, 'GET', '/v1/parties?type=broker&active=true', { token }), parties);
        expect(active.map((p) => p.id)).toEqual([P.rkAgarwal]);
      });

      it('unknown or other-tenant party → 404', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        expectError(await call(t, 'GET', `/v1/parties/${RANDOM_ID}`, { token }), 404, 'NOT_FOUND');
      });

      it('create is idempotent: a retry with the same key returns the same party', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const key = newKey();
        const a = await call(t, 'POST', '/v1/parties', { token, idempotencyKey: key, body: broker });
        const b = await call(t, 'POST', '/v1/parties', { token, idempotencyKey: key, body: broker });
        expect(b.body).toEqual(a.body);
        expect(b.headers['idempotent-replay']).toBe('true');
      });
    });

    describe('products', () => {
      it('owner creates TMT 32 mm for AIP and KRM: display name and tag are derived', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const p = expectOk(await post(t, token, '/v1/products', tmt32), productSchema, 201);
        expect(p).toMatchObject({ displayName: 'TMT Fe500D · 32 mm', tag: 'TMT', active: true });
      });

      it('no company → 422; a company of another tenant → 422 at companyIds; duplicate name → 422', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const none = await post(t, token, '/v1/products', { ...tmt32, companyIds: [] });
        expect(paths(none.body)).toContainEqual(['companyIds']);
        const other = await t.fixtures.createTenant('Other');
        const foreign = await post(t, token, '/v1/products', { ...tmt32, companyIds: [other.companyId] });
        expectError(foreign, 422, 'VALIDATION');
        expect(paths(foreign.body)).toContainEqual(['companyIds']);
        const dup = await post(t, token, '/v1/products', { ...tmt32, sizeLabel: '12 mm' });
        expectError(dup, 422, 'VALIDATION');
        expect(paths(dup.body)).toContainEqual(['sizeLabel']);
      });

      it('list: filtered by company, sorted by category then size (8 mm before 12 mm)', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.priya);
        const nap = expectOk(await call(t, 'GET', `/v1/products?companyId=${COMPANY.NAP}`, { token }), products);
        expect(nap.map((p) => p.displayName)).toEqual(['MS Billet · 100 × 100', 'MS Ingot · 4 inch']);
        const tmt = expectOk(await call(t, 'GET', '/v1/products?category=TMT', { token }), products);
        expect(tmt.map((p) => p.sizeLabel)).toEqual(['8 mm', '10 mm', '12 mm', '16 mm', '20 mm', '25 mm']);
      });

      it('an unused product can be deleted (204, then 404); stale edit → 409', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const p = expectOk(await post(t, token, '/v1/products', tmt32), productSchema, 201);
        const body = { ...tmt32, version: p.version, active: false };
        expectOk(await call(t, 'PATCH', `/v1/products/${p.id}`, { token, body }), productSchema);
        expectError(await call(t, 'PATCH', `/v1/products/${p.id}`, { token, body }), 409, 'STALE');
        expect((await call(t, 'DELETE', `/v1/products/${p.id}`, { token })).status).toBe(204);
        expectError(await call(t, 'GET', `/v1/products/${p.id}`, { token }), 404, 'NOT_FOUND');
      });

      it.todo('a product used on an order line → 409 PRODUCT_IN_USE (enabled with orders, Task 6)');
      it.todo('deactivating KRM with an open sub-order → 409 COMPANY_HAS_OPEN_ORDERS (Task 6)');
    });
  });
}
