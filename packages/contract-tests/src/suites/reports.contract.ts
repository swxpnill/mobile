import { describe, expect, it } from 'vitest';
import {
  SAMPLE_MASTERS,
  type Report,
  REPORT_KINDS,
  istDateOf,
  lineValue,
  orderSchema,
  paymentResultSchema,
  reportSchema,
  roundHalfUp,
  truckSchema,
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
  tokenFor,
  useTarget,
} from '../harness.ts';
import { pay, twoOrders } from './ledger.contract.ts';
import { CANVAS_ORDER, createOrder } from './orders.contract.ts';

const P = SAMPLE_MASTERS.ids.parties;

const monthRange = (t: ContractTarget) => {
  const today = istDateOf(t.clock.now());
  return `from=${today.slice(0, 7)}-01&to=${today}`;
};
const report = async (t: ContractTarget, token: string, kind: string, query: string): Promise<Report> =>
  expectOk(await call(t, 'GET', `/v1/reports/${kind}?${query}`, { token }), reportSchema);
const pathsOf = (body: unknown) =>
  validationDetailsSchema.parse((body as { details: unknown }).details).map((d) => d.path);

type OrderLine = ReturnType<typeof orderSchema.parse>['subOrders'][number]['lines'][number];
const billed = (l: OrderLine) => (l.rate ?? 0) + (l.overpricePerMt ?? 0);

/** A one-line order on `companyId` (the canvas order's first line there), with one dispatched truck. */
async function dispatched(
  t: ContractTarget,
  token: string,
  opts: { companyId: string; planKg: number; netKg: number; vehicleNo: string },
) {
  const src = CANVAS_ORDER.subOrders.find((s) => s.companyId === opts.companyId)!;
  const body = { ...CANVAS_ORDER, subOrders: [{ companyId: opts.companyId, lines: [src.lines[0]!] }] };
  const order = expectOk(await createOrder(t, token, body), orderSchema, 201);
  const sub = order.subOrders[0]!;
  const line = sub.lines[0]!;
  const { truckId } = await t.fixtures.addTruck({
    subOrderId: sub.id,
    state: 'dispatched',
    vehicleNo: opts.vehicleNo,
    tareKg: 12_000,
    plan: [{ orderLineId: line.id, plannedKg: opts.planKg }],
    allocations: [{ orderLineId: line.id, netKg: opts.netKg }],
  });
  return { order, line, truckId };
}

export function register(factory: TargetFactory): void {
  describe('contract: reports', () => {
    const target = useTarget(factory);

    it('dispatch register: one row per truck line, value at the billed rate, filtered by company', async () => {
      const t = target();
      const { owner, one, two } = await twoOrders(t);
      const krm = await dispatched(t, owner, {
        companyId: COMPANY.KRM,
        planKg: 20_000,
        netKg: 20_500,
        vehicleNo: 'CG 04 KK 0003',
      });
      const q = monthRange(t);
      const all = await report(t, owner, 'dispatch-register', q);
      if (all.kind !== 'dispatch-register') throw new Error('kind');
      expect(all.rows).toHaveLength(3);
      expect(all.truncated).toBe(false);
      const slip = async (truckId: string) =>
        expectOk(await call(t, 'GET', `/v1/trucks/${truckId}`, { token: owner }), truckSchema).loadingSlipNo;
      const row = (truckId: string) => all.rows.find((r) => r.truckId === truckId)!;
      expect(row(one.truckId)).toMatchObject({
        netKg: 24_180,
        billedRate: billed(one.orderLine),
        valueRupees: roundHalfUp(24_180 * billed(one.orderLine), 1000),
        loadingSlipNo: await slip(one.truckId),
        vehicleNo: 'CG 04 AA 0001',
      });
      expect(row(two.truckId).valueRupees).toBe(roundHalfUp(30_120 * billed(two.orderLine), 1000));
      expect(row(krm.truckId).valueRupees).toBe(roundHalfUp(20_500 * billed(krm.line), 1000));
      expect(all.summary.netKg).toBe(24_180 + 30_120 + 20_500);
      expect(all.summary.trucks).toBe(3);
      expect(all.summary.overUnderKg).toBe(500);
      expect(all.summary.valueRupees).toBe(all.rows.reduce((s, r) => s + r.valueRupees, 0));

      const onlyKrm = await report(t, owner, 'dispatch-register', `${q}&companyId=${COMPANY.KRM}`);
      if (onlyKrm.kind !== 'dispatch-register') throw new Error('kind');
      expect(onlyKrm.rows.map((r) => r.truckId)).toEqual([krm.truckId]);
      expect(onlyKrm.rows[0]!.companyCode).toBe('KRM');
    });

    it('Review Focus 5: a truck gross-captured 23:50 IST on 31 Oct stays in October after the clock moves on', async () => {
      const t = target();
      t.clock.advance(Date.parse('2026-10-31T18:20:00Z') - t.clock.now());
      const owner0 = await tokenFor(t, PEOPLE.rajesh);
      const made = await dispatched(t, owner0, {
        companyId: COMPANY.AIP,
        planKg: 24_000,
        netKg: 24_180,
        vehicleNo: 'CG 04 AA 0009',
      });
      t.clock.advance(Date.parse('2026-11-01T06:00:00Z') - t.clock.now());
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const rows = async (query: string) => {
        const r = await report(t, owner, 'dispatch-register', query);
        if (r.kind !== 'dispatch-register') throw new Error('kind');
        return r.rows;
      };
      const oct = await rows('from=2026-10-01&to=2026-10-31');
      expect(oct.map((r) => r.truckId)).toEqual([made.truckId]);
      expect(oct[0]!.date).toBe('2026-10-31');
      expect(await rows('from=2026-11-01&to=2026-11-01')).toEqual([]);
    });

    it('range checks: to before from, to tomorrow, 367 days are 422 on the right field', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const today = istDateOf(t.clock.now());
      const get = (from: string, to: string) =>
        call(t, 'GET', `/v1/reports/dispatch-register?from=${from}&to=${to}`, { token: owner });
      const before = expectError(await get(today, istDateOf(t.clock.now() - DAY)), 422, 'VALIDATION');
      expect(pathsOf(before)).toContainEqual(['to']);
      const future = expectError(await get(today, istDateOf(t.clock.now() + DAY)), 422, 'VALIDATION');
      expect(pathsOf(future)).toContainEqual(['to']);
      const long = expectError(await get(istDateOf(t.clock.now() - 366 * DAY), today), 422, 'VALIDATION');
      expect(pathsOf(long)).toContainEqual(['from']);
      expect((await get(istDateOf(t.clock.now() - 365 * DAY), today)).status).toBe(200);
      expectError(await get('2026-02-31', today), 422, 'VALIDATION');
    });

    it('pending orders: an order 14 days old is in bucket 11–20; the bucket filter works and the range is ignored', async () => {
      const t = target();
      t.clock.advance(-14 * DAY);
      const owner0 = await tokenFor(t, PEOPLE.rajesh);
      const old = expectOk(await createOrder(t, owner0), orderSchema, 201);
      t.clock.advance(14 * DAY);
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const fresh = expectOk(await createOrder(t, owner), orderSchema, 201);
      const today = istDateOf(t.clock.now());
      const q = `from=${today}&to=${today}`;
      const r = await report(t, owner, 'pending-orders', q);
      if (r.kind !== 'pending-orders') throw new Error('kind');
      const oldRows = r.rows.filter((x) => x.orderId === old.id);
      expect(oldRows).toHaveLength(2);
      expect(oldRows.every((x) => x.bucket === '11–20' && x.ageDays === 14)).toBe(true);
      expect(r.rows.filter((x) => x.orderId === fresh.id).every((x) => x.bucket === '0–5')).toBe(true);
      expect(r.summary.byBucket.map((b) => b.bucket)).toEqual(['0–5', '6–10', '11–20', '21+']);
      const low = await report(t, owner, 'pending-orders', `${q}&bucket=0%E2%80%935`);
      if (low.kind !== 'pending-orders') throw new Error('kind');
      expect(low.rows.some((x) => x.orderId === old.id)).toBe(false);
      expect(low.rows.length).toBeGreaterThan(0);
      expect(low.summary.byBucket.find((b) => b.bucket === '11–20')!.count).toBe(2);
    });

    it('broker-wise: commission, overprice, earned, paid (with TDS) and due', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      expectOk(await pay(t, owner), paymentResultSchema, 201);
      const r = await report(t, owner, 'broker-wise', monthRange(t));
      if (r.kind !== 'broker-wise') throw new Error('kind');
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({
        brokerId: P.rkAgarwal,
        netKg: 54_300,
        commissionRupees: 8_145,
        overpriceRupees: 7_254,
        earnedRupees: 15_399,
        paidRupees: 10_500,
        dueRupees: 4_899,
      });
      expect(r.summary).toMatchObject({ earnedRupees: 15_399, dueRupees: 4_899 });
    });

    it('customer-wise: booked against lifted, kg and rupees', async () => {
      const t = target();
      const { owner, one, two } = await twoOrders(t);
      const r = await report(t, owner, 'customer-wise', monthRange(t));
      if (r.kind !== 'customer-wise') throw new Error('kind');
      expect(r.rows).toHaveLength(1);
      const lines = [one.orderLine, two.orderLine];
      expect(r.rows[0]).toMatchObject({
        customerId: P.shubham,
        bookedKg: lines.reduce((s, l) => s + l.orderedKg, 0),
        bookedValueRupees: lines.reduce((s, l) => s + lineValue(l.orderedKg, billed(l)), 0),
        liftedKg: 54_300,
        liftedValueRupees:
          roundHalfUp(24_180 * billed(one.orderLine), 1000) + roundHalfUp(30_120 * billed(two.orderLine), 1000),
      });
    });

    it('product-wise: one row per product and length; unit-sales groups by company', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const krm = await dispatched(t, owner, {
        companyId: COMPANY.KRM,
        planKg: 20_000,
        netKg: 20_500,
        vehicleNo: 'CG 04 KK 0003',
      });
      const q = monthRange(t);
      const p = await report(t, owner, 'product-wise', q);
      if (p.kind !== 'product-wise') throw new Error('kind');
      expect(p.rows.map((r) => r.netKg).sort((a, b) => a - b)).toEqual([20_500, 24_180, 30_120]);
      expect(p.summary).toMatchObject({ netKg: 74_800, trucks: 3 });
      const u = await report(t, owner, 'unit-sales', q);
      if (u.kind !== 'unit-sales') throw new Error('kind');
      expect(u.summary.byCompany.map((c) => [c.companyCode, c.netKg, c.trucks])).toEqual([
        ['AIP', 54_300, 2],
        ['KRM', 20_500, 1],
      ]);
      const krmRow = u.summary.byCompany.find((c) => c.companyCode === 'KRM')!;
      expect(krmRow.valueRupees).toBe(roundHalfUp(20_500 * billed(krm.line), 1000));
    });

    it('loading variance: plan 24,000 and net 24,180 is +180 kg', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const made = await dispatched(t, owner, {
        companyId: COMPANY.AIP,
        planKg: 24_000,
        netKg: 24_180,
        vehicleNo: 'CG 04 AA 0010',
      });
      const r = await report(t, owner, 'loading-variance', monthRange(t));
      if (r.kind !== 'loading-variance') throw new Error('kind');
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ truckId: made.truckId, plannedKg: 24_000, netKg: 24_180, diffKg: 180 });
      expect(r.summary).toMatchObject({ trucks: 1, overTrucks: 1, underTrucks: 0, overKg: 180, underKg: 0 });
    });

    it('Review Focus 2: plant roles get 403 for every kind; city staff can read; an unknown kind is 404', async () => {
      const t = target();
      await twoOrders(t);
      const q = monthRange(t);
      for (const who of [PEOPLE.kiran, PEOPLE.ravi]) {
        const token = await tokenFor(t, who);
        for (const kind of REPORT_KINDS) {
          expectError(await call(t, 'GET', `/v1/reports/${kind}?${q}`, { token }), 403, 'FORBIDDEN');
        }
        expectError(await call(t, 'GET', `/v1/reports/unknown?${q}`, { token }), 403, 'FORBIDDEN');
      }
      const priya = await tokenFor(t, PEOPLE.priya);
      for (const kind of REPORT_KINDS) {
        expect((await report(t, priya, kind, q)).kind).toBe(kind);
      }
      expectError(await call(t, 'GET', `/v1/reports/unknown?${q}`, { token: priya }), 404, 'NOT_FOUND');
      expectError(await call(t, 'GET', `/v1/reports/broker-wise?${q}&bogus=1`, { token: priya }), 422, 'VALIDATION');
    });
  });
}
