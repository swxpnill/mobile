import { describe, expect, it } from 'vitest';
import {
  type BrokerLedger,
  SAMPLE_MASTERS,
  brokerDuesSchema,
  brokerLedgerSchema,
  brokerStatementSchema,
  istDateOf,
  orderSchema,
  paymentResultSchema,
  truckSchema,
  validationDetailsSchema,
} from '@tonnage/shared';
import {
  COMPANY,
  DAY,
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
import { CANVAS_ORDER, createOrder } from './orders.contract.ts';

const P = SAMPLE_MASTERS.ids.parties;
const BROKER = P.rkAgarwal;

const payBody = (over: Record<string, unknown>, now: number) => ({
  paidRupees: 10_000,
  tdsRupees: 500,
  mode: 'neft',
  utr: '223614',
  paidOn: istDateOf(now),
  ...over,
});
export const pay = (t: ContractTarget, token: string, over: Record<string, unknown> = {}, key = newKey(), id = BROKER) =>
  call(t, 'POST', `/v1/brokers/${id}/payments`, { token, idempotencyKey: key, body: payBody(over, t.clock.now()) });
const reverse = (t: ContractTarget, token: string, id: string, reason = 'Wrong UTR') =>
  call(t, 'POST', `/v1/ledger/${id}/reverse`, { token, idempotencyKey: newKey(), body: { reason } });
const ledger = async (t: ContractTarget, token: string, query = '', id = BROKER) =>
  expectOk(await call(t, 'GET', `/v1/brokers/${id}/ledger${query}`, { token }), brokerLedgerSchema);
const paths = (body: unknown) =>
  validationDetailsSchema.parse((body as { details: unknown }).details).map((d) => d.path);

/** Two single-line orders for R.K. Agarwal, each with one dispatched truck (24,180 kg, 30,120 kg). */
export async function twoOrders(t: ContractTarget) {
  const owner = await tokenFor(t, PEOPLE.rajesh);
  const lines = CANVAS_ORDER.subOrders[0]!.lines;
  const make = async (line: (typeof lines)[number], netKg: number, vehicleNo: string) => {
    const body = { ...CANVAS_ORDER, subOrders: [{ companyId: COMPANY.AIP, lines: [line] }] };
    const order = expectOk(await createOrder(t, owner, body), orderSchema, 201);
    const sub = order.subOrders[0]!;
    const orderLine = sub.lines[0]!;
    const { truckId } = await t.fixtures.addTruck({
      subOrderId: sub.id,
      state: 'dispatched',
      vehicleNo,
      tareKg: 12_000,
      plan: [{ orderLineId: orderLine.id, plannedKg: netKg }],
      allocations: [{ orderLineId: orderLine.id, netKg }],
    });
    return { order, orderLine, truckId };
  };
  const one = await make(lines[0]!, 24_180, 'CG 04 AA 0001'); // overprice 300
  t.clock.advance(60_000);
  const two = await make(lines[1]!, 30_120, 'CG 04 AA 0002'); // no overprice
  return { owner, one, two };
}

export function register(factory: TargetFactory): void {
  describe('contract: broker ledger', () => {
    const target = useTarget(factory);

    it('ledger: due, unpaid kg, two earnings with their lines', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const l = await ledger(t, owner);
      expect(l.summary).toMatchObject({ dueRupees: 15_399, unpaidKg: 54_300 });
      expect(l.broker.id).toBe(BROKER);
      expect(l.items).toHaveLength(2);
      const first = l.items.find((i) => i.truck?.netKg === 24_180)!;
      expect(first.kind).toBe('earning');
      expect(first.amountRupees).toBe(10_881);
      expect(first.earningLines).toMatchObject([{ netKg: 24_180, commissionPerMt: 150, overpricePerMt: 300 }]);
      // Newest first.
      expect(l.items[0]!.truck?.netKg).toBe(30_120);
    });

    it('records a payment: negative entry, new due, summary', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const r = expectOk(await pay(t, owner), paymentResultSchema, 201);
      expect(r.entry).toMatchObject({ kind: 'payment', amountRupees: -10_500 });
      expect(r.entry.payment).toMatchObject({ mode: 'neft', utr: '223614', paidRupees: 10_000, tdsRupees: 500 });
      expect(r.dueRupees).toBe(4_899);
      const l = await ledger(t, owner);
      expect(l.summary).toMatchObject({ dueRupees: 4_899, unpaidKg: 30_967, paidThisMonthRupees: 10_500 });
      expect(l.items[0]!.id).toBe(r.entry.id);
    });

    it('Review Focus 1: the same key replays the same response and records one payment', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const key = newKey();
      const a = await pay(t, owner, {}, key);
      const b = await pay(t, owner, {}, key);
      expect(b.status).toBe(201);
      expect(b.body).toEqual(a.body);
      expect(b.headers['idempotent-replay']).toBe('true');
      const l = await ledger(t, owner, '?view=payments');
      expect(l.items.filter((i) => i.kind === 'payment')).toHaveLength(1);
    });

    it('422: NEFT without UTR, a future paidOn, an impossible date, TDS above the payment', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const noUtr = expectError(await pay(t, owner, { utr: null }), 422, 'VALIDATION');
      expect(paths(noUtr)).toContainEqual(['utr']);
      const tomorrow = istDateOf(t.clock.now() + DAY);
      const future = expectError(await pay(t, owner, { paidOn: tomorrow }), 422, 'VALIDATION');
      expect(paths(future)).toContainEqual(['paidOn']);
      const bad = expectError(await pay(t, owner, { paidOn: '2026-02-31' }), 422, 'VALIDATION');
      expect(paths(bad)).toContainEqual(['paidOn']);
      const tds = expectError(await pay(t, owner, { paidRupees: 1_000, tdsRupees: 1_001 }), 422, 'VALIDATION');
      expect(paths(tds)).toContainEqual(['tdsRupees']);
      expect((await ledger(t, owner, '?view=payments')).items).toEqual([]);
    });

    it('paidOn: exactly 365 days back is accepted, 366 days back is 422 on paidOn', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const old = expectError(
        await pay(t, owner, { paidOn: istDateOf(t.clock.now() - 366 * DAY) }),
        422,
        'VALIDATION',
      );
      expect(paths(old)).toContainEqual(['paidOn']);
      const ok = await pay(t, owner, { paidOn: istDateOf(t.clock.now() - 365 * DAY) });
      expectOk(ok, paymentResultSchema, 201);
    });

    it('reverses a payment once; earnings and reversals are not reversible; the reason is checked', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const paid = expectOk(await pay(t, owner), paymentResultSchema, 201);
      expectError(await reverse(t, owner, paid.entry.id, 'ok'), 422, 'VALIDATION');
      const rev = expectOk(await reverse(t, owner, paid.entry.id), paymentResultSchema, 201);
      expect(rev.entry).toMatchObject({
        kind: 'reversal',
        amountRupees: 10_500,
        reversesId: paid.entry.id,
        note: 'Wrong UTR',
      });
      expect(rev.dueRupees).toBe(15_399);
      expectError(await reverse(t, owner, paid.entry.id), 409, 'ALREADY_REVERSED');
      expectError(await reverse(t, owner, rev.entry.id), 409, 'NOT_REVERSIBLE');
      const earning = (await ledger(t, owner, '?view=earnings')).items[0]!;
      expectError(await reverse(t, owner, earning.id), 409, 'NOT_REVERSIBLE');
      expectError(await reverse(t, owner, RANDOM_ID), 404, 'NOT_FOUND');
      const l = await ledger(t, owner, '?view=payments');
      expect(l.items.map((i) => i.kind).sort()).toEqual(['payment', 'reversal']);
      expect(l.items.find((i) => i.id === paid.entry.id)!.reversedById).toBe(rev.entry.id);
    });

    it('an overpayment leaves a negative due', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const r = expectOk(await pay(t, owner, { paidRupees: 20_000, tdsRupees: 0 }), paymentResultSchema, 201);
      expect(r.dueRupees).toBe(-4_601);
    });

    it('Review Focus 3: a weight correction moves the due by the difference; a hard delete keeps the payment', async () => {
      const t = target();
      const { owner, one } = await twoOrders(t);
      expectOk(await pay(t, owner, { tdsRupees: 0 }), paymentResultSchema, 201);
      const truck = expectOk(await call(t, 'GET', `/v1/trucks/${one.truckId}`, { token: owner }), truckSchema);
      const fix = await call(t, 'POST', `/v1/trucks/${one.truckId}/correct-weight`, {
        token: owner,
        idempotencyKey: newKey(),
        body: {
          tareKg: 12_000,
          grossKg: 34_000,
          allocations: [{ orderLineId: one.orderLine.id, netKg: 22_000 }],
          reason: 'Weighbridge recalibrated',
          version: truck.version,
        },
      });
      expect(fix.status).toBe(200);
      expect((await ledger(t, owner)).summary.dueRupees).toBe(15_399 - 981 - 10_000);
      const del = await call(t, 'DELETE', `/v1/orders/${one.order.id}`, {
        token: owner,
        body: { confirmNumber: one.order.number },
      });
      expect(del.status).toBe(204);
      const l = await ledger(t, owner);
      expect(l.summary.dueRupees).toBe(4_518 - 10_000);
      expect(l.items.filter((i) => i.kind === 'earning')).toHaveLength(1);
      expect(l.items.filter((i) => i.kind === 'payment')).toHaveLength(1);
    });

    it('pages the ledger newest first with an opaque cursor', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      expectOk(await pay(t, owner), paymentResultSchema, 201);
      const p1: BrokerLedger = await ledger(t, owner, '?limit=2');
      expect(p1.items).toHaveLength(2);
      expect(p1.nextBefore).not.toBeNull();
      const p2 = await ledger(t, owner, `?limit=2&before=${encodeURIComponent(p1.nextBefore!)}`);
      expect(p2.items).toHaveLength(1);
      expect(p2.nextBefore).toBeNull();
      expect(p2.summary.dueRupees).toBe(p1.summary.dueRupees);
      expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(3);
      expectError(await call(t, 'GET', `/v1/brokers/${BROKER}/ledger?before=junk`, { token: owner }), 422, 'VALIDATION');
    });

    it('dues: every active broker, the total sums positive dues only', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const dues = expectOk(await call(t, 'GET', '/v1/brokers/dues', { token: owner }), brokerDuesSchema);
      expect(dues.items.find((i) => i.brokerId === BROKER)).toMatchObject({ dueRupees: 15_399 });
      expect(dues.totalDueRupees).toBe(15_399);
      expectOk(await pay(t, owner, { paidRupees: 20_000, tdsRupees: 0 }), paymentResultSchema, 201);
      const after = expectOk(await call(t, 'GET', '/v1/brokers/dues', { token: owner }), brokerDuesSchema);
      expect(after.items.find((i) => i.brokerId === BROKER)!.dueRupees).toBe(-4_601);
      expect(after.totalDueRupees).toBe(after.items.filter((i) => i.dueRupees > 0).reduce((s, i) => s + i.dueRupees, 0));
      expect(after.totalDueRupees).toBe(0);
    });

    it('statement: first of the month to today, items ascending; bad ranges are 422', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      expectOk(await pay(t, owner), paymentResultSchema, 201);
      const today = istDateOf(t.clock.now());
      const from = `${today.slice(0, 7)}-01`;
      const q = (f: string, to: string) =>
        call(t, 'GET', `/v1/brokers/${BROKER}/statement?from=${f}&to=${to}`, { token: owner });
      const s = expectOk(await q(from, today), brokerStatementSchema);
      expect(s).toMatchObject({
        openingDueRupees: 0,
        earnedRupees: 15_399,
        // paidRupees is paid + TDS (what leaves the due); tdsRupees is the TDS part of it.
        paidRupees: 10_500,
        tdsRupees: 500,
        closingDueRupees: 4_899,
      });
      const times = s.items.map((i) => i.createdAt);
      expect(times).toEqual([...times].sort());
      expect(s.items).toHaveLength(3);
      expect(paths(expectError(await q('2026-02-31', today), 422, 'VALIDATION'))).toContainEqual(['from']);
      expect(paths(expectError(await q(from, '2026-13-01'), 422, 'VALIDATION'))).toContainEqual(['to']);
      expectError(await q(today, from), 422, 'VALIDATION');
      expectError(await q(from, istDateOf(t.clock.now() + DAY)), 422, 'VALIDATION');
    });

    it('Review Focus 2: plant roles get 403 on all five routes; city staff can pay and reverse; scope is 404', async () => {
      const t = target();
      const { owner } = await twoOrders(t);
      const paid = expectOk(await pay(t, owner), paymentResultSchema, 201);
      for (const who of [PEOPLE.kiran, PEOPLE.ravi]) {
        const token = await tokenFor(t, who);
        expectError(await call(t, 'GET', '/v1/brokers/dues', { token }), 403, 'FORBIDDEN');
        expectError(await call(t, 'GET', `/v1/brokers/${BROKER}/ledger`, { token }), 403, 'FORBIDDEN');
        expectError(
          await call(t, 'GET', `/v1/brokers/${BROKER}/statement?from=2026-01-01&to=2026-01-02`, { token }),
          403,
          'FORBIDDEN',
        );
        expectError(await pay(t, token), 403, 'FORBIDDEN');
        expectError(await reverse(t, token, paid.entry.id), 403, 'FORBIDDEN');
      }
      const priya = await tokenFor(t, PEOPLE.priya);
      expect((await ledger(t, priya)).summary.dueRupees).toBe(4_899);
      const p2 = expectOk(await pay(t, priya, { paidRupees: 100, tdsRupees: 0 }), paymentResultSchema, 201);
      expectOk(await reverse(t, priya, p2.entry.id), paymentResultSchema, 201);

      expectError(await pay(t, owner, {}, newKey(), P.shubham), 404, 'NOT_FOUND');
      expectError(await call(t, 'GET', `/v1/brokers/${P.shubham}/ledger`, { token: owner }), 404, 'NOT_FOUND');
      expectError(await call(t, 'GET', `/v1/brokers/${RANDOM_ID}/ledger`, { token: owner }), 404, 'NOT_FOUND');
      const other = await t.fixtures.createTenant('Other Group');
      const theirs = await tokenFor(t, { mobile: other.ownerMobile });
      expectError(await reverse(t, theirs, paid.entry.id), 404, 'NOT_FOUND');
      expectError(await call(t, 'GET', `/v1/brokers/${BROKER}/ledger`, { token: theirs }), 404, 'NOT_FOUND');
      expectError(await pay(t, theirs), 404, 'NOT_FOUND');
    });
  });
}
