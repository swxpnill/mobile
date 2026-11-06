import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MONEY_KEYS,
  SAMPLE_MASTERS,
  companySchema,
  createOrderBodySchema,
  draftSchema,
  homeSchema,
  orderListSchema,
  orderSchema,
  validationDetailsSchema,
} from '@tonnage/shared';
import {
  COMPANY,
  DAY,
  PEOPLE,
  type ContractTarget,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  newKey,
  tokenFor,
  useTarget,
} from '../harness.ts';

const P = SAMPLE_MASTERS.ids.parties;
const PR = SAMPLE_MASTERS.ids.products;
const A = SAMPLE_MASTERS.ids.addresses;

const line = (o: Record<string, unknown> = {}) => ({
  productId: PR.tmt12,
  length: { value: 12, unit: 'm' },
  orderedKg: 24_000,
  typedRate: null,
  overpricePerMt: 300,
  ...o,
});

/** The canvas order: Shubham Traders via R.K. Agarwal, AIP 3 lines + KRM 1 line, ₹38,64,200. */
export const CANVAS_ORDER = {
  draftId: null,
  type: 'customer_broker',
  customerId: P.shubham,
  brokerId: P.rkAgarwal,
  commissionPerMt: 150,
  billToId: A.shubhamBill,
  shipToId: A.shubhamHingna,
  pricingMethod: 'basic_conversion',
  basicRate: 44_500,
  subOrders: [
    {
      companyId: COMPANY.AIP,
      lines: [
        line(),
        line({ length: { value: 6, unit: 'm' }, orderedKg: 10_000, overpricePerMt: 0 }),
        line({ productId: PR.tmt16, orderedKg: 20_000 }),
      ],
    },
    {
      companyId: COMPANY.KRM,
      lines: [line({ productId: PR.tmt16, length: { value: 40, unit: 'ft' }, orderedKg: 30_000, typedRate: 45_600 })],
    },
  ],
  notify: { customer: true, broker: true },
};

/** A small order on one company only. */
const krmOnly = {
  ...CANVAS_ORDER,
  type: 'customer',
  customerId: P.patel,
  brokerId: null,
  commissionPerMt: null,
  billToId: A.patelBill,
  shipToId: A.patelSite2,
  pricingMethod: 'direct',
  basicRate: null,
  subOrders: [{ companyId: COMPANY.KRM, lines: [line({ productId: PR.tmt20, typedRate: 46_000, overpricePerMt: 0 })] }],
  notify: { customer: true, broker: false },
};

export const createOrder = async (t: ContractTarget, token: string, body: object = CANVAS_ORDER) =>
  call(t, 'POST', '/v1/orders', { token, idempotencyKey: newKey(), body });

const paths = (body: unknown) =>
  validationDetailsSchema.parse((body as { details: unknown }).details).map((d) => d.path);

/** Every key anywhere in a JSON value. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}
const moneyKeysIn = (v: unknown) => [...keysDeep(v)].filter((k) => MONEY_KEYS.has(k));

const drafts = z.array(draftSchema);

export function register(factory: TargetFactory): void {
  describe('contract: orders', () => {
    const target = useTarget(factory);
    // Some cases move the clock (aged orders, financial-year change); every case starts at the
    // same instant so absolute dates and numbers stay predictable.
    let startedAt = 0;
    beforeEach(() => {
      startedAt = target().clock.now();
    });
    afterEach(() => {
      const t = target();
      t.clock.advance(startedAt - t.clock.now());
    });

    describe('create', () => {
      it('the canvas order: number, sub-orders A/B, server-computed value and broker estimate', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const o = expectOk(await createOrder(t, token), orderSchema, 201);
        expect(o).toMatchObject({
          number: 'SO-2611-0001',
          status: 'open',
          commissionPerMtSnapshot: 150,
          estimatedValue: 3_864_200,
          brokerEarningEstimate: { commission: 12_600, overprice: 22_200, total: 34_800 },
          customer: { id: P.shubham, name: 'Shubham Traders', city: 'Nagpur' },
          shipTo: { id: A.shubhamHingna, label: 'Hingna MIDC site' },
          createdBy: { id: PEOPLE.rajesh.id, name: 'Rajesh Agrawal' },
          ageDays: 0,
          isAged: false,
        });
        expect(o.subOrders.map((s) => [s.number, s.companyCode])).toEqual([
          ['SO-2611-0001-A', 'AIP'],
          ['SO-2611-0001-B', 'KRM'],
        ]);
        const aip = o.subOrders[0]!;
        expect(aip.lines[0]).toMatchObject({ productName: 'TMT Fe500D · 12 mm', rate: 46_000, rateEdited: false, conversionSnapshot: 1_500, lineValue: 1_111_200, pendingKg: 24_000 });
        expect(o.subOrders[1]!.lines[0]).toMatchObject({ rate: 45_600, rateEdited: true });
        expect(o.totals).toMatchObject({ orderedKg: 84_000, pendingKg: 84_000, dispatchedKg: 0 });
      });

      it('Review Focus 2: a retried create (same key) makes one order and replays the same body', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.priya);
        const key = newKey();
        const first = await call(t, 'POST', '/v1/orders', { token, idempotencyKey: key, body: CANVAS_ORDER });
        const again = await call(t, 'POST', '/v1/orders', { token, idempotencyKey: key, body: CANVAS_ORDER });
        expect(again.body).toEqual(first.body);
        expect(again.headers['idempotent-replay']).toBe('true');
        const list = expectOk(await call(t, 'GET', '/v1/orders', { token }), orderListSchema);
        expect(list.counts.all).toBe(1);
      });

      it('a product the company does not make → 409 PRODUCT_NOT_FOR_COMPANY pointing at the line; nothing saved', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const body = { ...krmOnly, subOrders: [{ companyId: COMPANY.NAP, lines: [line({ productId: PR.tmt16, typedRate: 46_000 })] }] };
        const err = expectError(await createOrder(t, token, body), 409, 'PRODUCT_NOT_FOR_COMPANY');
        expect(err.details).toEqual({ subOrderIndex: 0, lineIndex: 0 });
        const list = expectOk(await call(t, 'GET', '/v1/orders', { token }), orderListSchema);
        expect(list.counts.all).toBe(0);
        // The refused attempt must not have used up a number.
        expect(expectOk(await createOrder(t, token, krmOnly), orderSchema, 201).number).toBe('SO-2611-0001');
      });

      it('an inactive company → 409 COMPANY_INACTIVE', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const vsl = expectOk(await call(t, 'GET', `/v1/companies/${COMPANY.VSL}`, { token }), companySchema);
        expectOk(await call(t, 'PATCH', `/v1/companies/${COMPANY.VSL}`, { token, body: { version: vsl.version, active: false } }), companySchema);
        const body = { ...krmOnly, subOrders: [{ companyId: COMPANY.VSL, lines: [line({ productId: PR.angle, typedRate: 52_000 })] }] };
        expectError(await createOrder(t, token, body), 409, 'COMPANY_INACTIVE');
      });

      it('wrong parties → 422: a broker as customer, an address of another party, an unknown product', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const asCustomer = await createOrder(t, token, { ...CANVAS_ORDER, customerId: P.mittal });
        expectError(asCustomer, 422, 'VALIDATION');
        expect(paths(asCustomer.body)).toContainEqual(['customerId']);
        const foreignAddress = await createOrder(t, token, { ...CANVAS_ORDER, shipToId: A.patelSite2 });
        expect(paths(foreignAddress.body)).toContainEqual(['shipToId']);
        const unknownProduct = await createOrder(t, token, {
          ...krmOnly,
          subOrders: [{ companyId: COMPANY.KRM, lines: [line({ productId: COMPANY.AIP, typedRate: 1 })] }],
        });
        expect(paths(unknownProduct.body)).toContainEqual(['subOrders', 0, 'lines', 0, 'productId']);
      });

      it('plant head and supervisor cannot create (403)', async () => {
        const t = target();
        for (const who of [PEOPLE.kiran, PEOPLE.ravi]) {
          expectError(await createOrder(t, await tokenFor(t, who)), 403, 'FORBIDDEN');
        }
      });
    });

    describe('numbering', () => {
      it('Review Focus 5: 31 Mar 23:50 IST and 1 Apr 00:10 IST use different FY series; YYMM is IST', async () => {
        const t = target();
        t.clock.advance(Date.parse('2027-03-31T18:20:00Z') - t.clock.now());
        let token = await tokenFor(t, PEOPLE.rajesh);
        expect(expectOk(await createOrder(t, token, krmOnly), orderSchema, 201).number).toBe('SO-2703-0001');
        expect(expectOk(await createOrder(t, token, krmOnly), orderSchema, 201).number).toBe('SO-2703-0002');
        t.clock.advance(20 * 60_000);
        token = await tokenFor(t, PEOPLE.rajesh);
        expect(expectOk(await createOrder(t, token, krmOnly), orderSchema, 201).number).toBe('SO-2704-0001');
      });
    });

    describe('scope and money', () => {
      it('Review Focus 1: Kiran (plant head, Siltara/AIP) sees only the AIP sub-order and no money key', async () => {
        const t = target();
        const o = expectOk(await createOrder(t, await tokenFor(t, PEOPLE.rajesh)), orderSchema, 201);
        const kiran = await tokenFor(t, PEOPLE.kiran);
        const res = await call(t, 'GET', `/v1/orders/${o.id}`, { token: kiran });
        const seen = expectOk(res, orderSchema);
        expect(seen.subOrders.map((s) => s.companyCode)).toEqual(['AIP']);
        expect(seen.totals.orderedKg).toBe(54_000);
        expect(moneyKeysIn(res.body)).toEqual([]);
        const list = await call(t, 'GET', '/v1/orders', { token: kiran });
        expect(moneyKeysIn(list.body)).toEqual([]);
        expect(expectOk(list, orderListSchema).items[0]?.companyCodes).toEqual(['AIP']);
      });

      it('an order with no sub-order in the plant head’s scope is 404 for them and absent from the list', async () => {
        const t = target();
        const o = expectOk(await createOrder(t, await tokenFor(t, PEOPLE.rajesh), krmOnly), orderSchema, 201);
        const kiran = await tokenFor(t, PEOPLE.kiran);
        expectError(await call(t, 'GET', `/v1/orders/${o.id}`, { token: kiran }), 404, 'NOT_FOUND');
        expect(expectOk(await call(t, 'GET', '/v1/orders', { token: kiran }), orderListSchema).counts.all).toBe(0);
      });

      it('supervisors have no order view (403)', async () => {
        const t = target();
        expectError(await call(t, 'GET', '/v1/orders', { token: await tokenFor(t, PEOPLE.ravi) }), 403, 'FORBIDDEN');
      });
    });

    describe('list', () => {
      it('search by number digits, filter by company (totals of that company only), status counts', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const canvas = expectOk(await createOrder(t, token), orderSchema, 201);
        expectOk(await createOrder(t, token, krmOnly), orderSchema, 201);
        const found = expectOk(await call(t, 'GET', '/v1/orders?q=0001', { token }), orderListSchema);
        expect(found.items.map((i) => i.number)).toEqual(['SO-2611-0001']);
        const krm = expectOk(await call(t, 'GET', `/v1/orders?companyId=${COMPANY.KRM}`, { token }), orderListSchema);
        expect(krm.items.map((i) => [i.number, i.totals.orderedKg])).toEqual([
          ['SO-2611-0002', 24_000],
          ['SO-2611-0001', 30_000],
        ]);
        // A dispatched truck on the KRM sub-order makes the canvas order partly dispatched.
        const sub = canvas.subOrders[1]!;
        await t.fixtures.addTruck({
          subOrderId: sub.id,
          state: 'dispatched',
          vehicleNo: 'CG 07 BR 8810',
          tareKg: 12_000,
          plan: [{ orderLineId: sub.lines[0]!.id, plannedKg: 25_000 }],
          allocations: [{ orderLineId: sub.lines[0]!.id, netKg: 24_800 }],
        });
        const partly = expectOk(await call(t, 'GET', '/v1/orders?status=partly_dispatched', { token }), orderListSchema);
        expect(partly.items.map((i) => i.number)).toEqual(['SO-2611-0001']);
        expect(partly.counts).toMatchObject({ all: 2, open: 1, partly_dispatched: 1, completed: 0 });
        expect(partly.items[0]!.productsLabel).toBe('TMT 12, 16 mm');
      });

      it('pages with a cursor, newest first, without repeats', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        for (let i = 0; i < 5; i++) {
          expectOk(await createOrder(t, token, krmOnly), orderSchema, 201);
          t.clock.advance(60_000);
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const qs: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
          const page = expectOk(await call(t, 'GET', `/v1/orders?limit=2${qs}`, { token }), orderListSchema);
          seen.push(...page.items.map((i) => i.number));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual(['SO-2611-0005', 'SO-2611-0004', 'SO-2611-0003', 'SO-2611-0002', 'SO-2611-0001']);
      });

      it('aged: pending orders older than agedOrderDays (10) are flagged and counted on Home', async () => {
        const t = target();
        const o = expectOk(await createOrder(t, await tokenFor(t, PEOPLE.rajesh), krmOnly), orderSchema, 201);
        t.clock.advance(11 * DAY);
        const token = await tokenFor(t, PEOPLE.rajesh);
        const aged = expectOk(await call(t, 'GET', '/v1/orders?aged=true', { token }), orderListSchema);
        expect(aged.items.map((i) => [i.id, i.ageDays, i.isAged])).toEqual([[o.id, 11, true]]);
        expect(expectOk(await call(t, 'GET', '/v1/home', { token }), homeSchema).agedOrders).toBe(1);
      });
    });

    describe('home', () => {
      it('owner: pending per company, booked today with value; Kiran: AIP only, no value', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        expectOk(await createOrder(t, token), orderSchema, 201);
        const home = expectOk(await call(t, 'GET', '/v1/home', { token }), homeSchema);
        expect(home).toMatchObject({
          pendingKg: 84_000,
          openOrders: 1,
          unitCount: 4,
          agedOrders: 0,
          agedOrderDays: 10,
          bookedToday: { kg: 84_000, orders: 1, valueRupees: 3_864_200 },
          dispatchedToday: { kg: 0, trucks: 0 },
        });
        expect(home.perCompany.map((c) => [c.code, c.pendingKg])).toEqual([
          ['AIP', 54_000],
          ['KRM', 30_000],
          ['NAP', 0],
          ['VSL', 0],
        ]);
        const krm = expectOk(await call(t, 'GET', `/v1/home?companyId=${COMPANY.KRM}`, { token }), homeSchema);
        expect(krm).toMatchObject({ pendingKg: 30_000, openOrders: 1, unitCount: 1 });
        const kiranRes = await call(t, 'GET', '/v1/home', { token: await tokenFor(t, PEOPLE.kiran) });
        expect(expectOk(kiranRes, homeSchema)).toMatchObject({ pendingKg: 54_000, unitCount: 1 });
        expect(moneyKeysIn(kiranRes.body)).toEqual([]);
      });
    });

    describe('drafts', () => {
      it('create → save twice with versions → a stale save is refused → purged after 7 days', async () => {
        const t = target();
        let token = await tokenFor(t, PEOPLE.priya);
        const created = expectOk(
          await call(t, 'POST', '/v1/orders/drafts', { token, idempotencyKey: newKey(), body: { payload: { step: 1 } } }),
          draftSchema,
          201,
        );
        const v2 = expectOk(
          await call(t, 'PUT', `/v1/orders/drafts/${created.id}`, { token, body: { payload: { step: 2 }, version: 1 } }),
          draftSchema,
        );
        expect(v2).toMatchObject({ version: 2, payload: { step: 2 }, createdBy: { name: 'Priya Sharma' } });
        expectError(
          await call(t, 'PUT', `/v1/orders/drafts/${created.id}`, { token, body: { payload: { step: 3 }, version: 1 } }),
          409,
          'STALE',
        );
        expect(expectOk(await call(t, 'GET', '/v1/orders/drafts', { token }), drafts)).toHaveLength(1);
        t.clock.advance(8 * DAY);
        token = await tokenFor(t, PEOPLE.priya);
        expect(expectOk(await call(t, 'GET', '/v1/orders/drafts', { token }), drafts)).toHaveLength(0);
        expectError(await call(t, 'GET', `/v1/orders/drafts/${created.id}`, { token }), 404, 'NOT_FOUND');
      });

      it('drafts are private to their creator; the owner sees everyone’s', async () => {
        const t = target();
        const priya = await tokenFor(t, PEOPLE.priya);
        const d = expectOk(
          await call(t, 'POST', '/v1/orders/drafts', { token: priya, idempotencyKey: newKey(), body: { payload: {} } }),
          draftSchema,
          201,
        );
        const amit = await tokenFor(t, PEOPLE.amit);
        expect(expectOk(await call(t, 'GET', '/v1/orders/drafts', { token: amit }), drafts)).toHaveLength(0);
        expectError(await call(t, 'GET', `/v1/orders/drafts/${d.id}`, { token: amit }), 404, 'NOT_FOUND');
        const rajesh = await tokenFor(t, PEOPLE.rajesh);
        expect(expectOk(await call(t, 'GET', '/v1/orders/drafts', { token: rajesh }), drafts)).toHaveLength(1);
      });

      it('creating an order from a draft removes the draft', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const d = expectOk(
          await call(t, 'POST', '/v1/orders/drafts', { token, idempotencyKey: newKey(), body: { payload: {} } }),
          draftSchema,
          201,
        );
        expectOk(await createOrder(t, token, { ...CANVAS_ORDER, draftId: d.id }), orderSchema, 201);
        expect(expectOk(await call(t, 'GET', '/v1/orders/drafts', { token }), drafts)).toHaveLength(0);
      });

      it('duplicate returns a draft that re-creates the same order', async () => {
        const t = target();
        const token = await tokenFor(t, PEOPLE.rajesh);
        const o = expectOk(await createOrder(t, token), orderSchema, 201);
        const d = expectOk(
          await call(t, 'POST', `/v1/orders/${o.id}/duplicate`, { token, idempotencyKey: newKey() }),
          draftSchema,
          201,
        );
        const body = createOrderBodySchema.parse({ ...d.payload, draftId: d.id });
        const copy = expectOk(await createOrder(t, token, body), orderSchema, 201);
        expect(copy.number).toBe('SO-2611-0002');
        expect(copy.estimatedValue).toBe(o.estimatedValue);
        expect(copy.subOrders.map((s) => s.lines.length)).toEqual([3, 1]);
      });
    });
  });
}
