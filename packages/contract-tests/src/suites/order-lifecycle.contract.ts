import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Order,
  SAMPLE_MASTERS,
  activityEntrySchema,
  deletePreviewSchema,
  openTrucksDetailsSchema,
  orderSchema,
} from '@tonnage/shared';
import {
  COMPANY,
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
import { CANVAS_ORDER, createOrder } from './orders.contract.ts';

const P = SAMPLE_MASTERS.ids.parties;
const PR = SAMPLE_MASTERS.ids.products;
const A = SAMPLE_MASTERS.ids.addresses;

/** Like canvas SO-2611-0141: Patel Infra, KRM, direct, 16/20/25 mm. */
const PATEL = {
  draftId: null,
  type: 'customer',
  customerId: P.patel,
  brokerId: null,
  commissionPerMt: null,
  billToId: A.patelBill,
  shipToId: A.patelSite2,
  pricingMethod: 'direct',
  basicRate: null,
  subOrders: [
    {
      companyId: COMPANY.KRM,
      lines: [
        { productId: PR.tmt16, length: { value: 12, unit: 'm' }, orderedKg: 40_000, typedRate: 46_500, overpricePerMt: 0 },
        { productId: PR.tmt20, length: { value: 12, unit: 'm' }, orderedKg: 50_000, typedRate: 46_000, overpricePerMt: 0 },
        { productId: PR.tmt25, length: { value: 6, unit: 'm' }, orderedKg: 30_000, typedRate: 45_800, overpricePerMt: 0 },
      ],
    },
  ],
  notify: { customer: true, broker: false },
};

/** The PATCH body that leaves the order exactly as it is. */
function editBody(o: Order) {
  return {
    type: o.type,
    customerId: o.customer?.id ?? null,
    brokerId: o.broker?.id ?? null,
    commissionPerMt: o.commissionPerMtSnapshot ?? null,
    billToId: o.billTo?.id ?? null,
    shipToId: o.shipTo?.id ?? null,
    pricingMethod: o.pricingMethod,
    basicRate: o.basicRate ?? null,
    notify: o.notify,
    version: o.version,
    subOrders: o.subOrders.map((s) => ({
      id: s.id,
      companyId: s.companyId,
      lines: s.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        length: l.length,
        orderedKg: l.orderedKg,
        typedRate: o.pricingMethod === 'direct' || l.rateEdited ? (l.rate ?? null) : null,
        overpricePerMt: l.overpricePerMt ?? 0,
      })),
    })),
  };
}
type EditBody = ReturnType<typeof editBody>;
const withLine = (b: EditBody, li: number, change: Record<string, unknown>): EditBody => ({
  ...b,
  subOrders: b.subOrders.map((s, si) =>
    si === 0 ? { ...s, lines: s.lines.map((l, i) => (i === li ? { ...l, ...change } : l)) } : s,
  ),
});

/** Patel order with 28.400 MT dispatched on the 16 mm line and a loading truck planned on 25 mm. */
async function patelInProgress(t: ContractTarget) {
  const rajesh = await tokenFor(t, PEOPLE.rajesh);
  const o = expectOk(await createOrder(t, rajesh, PATEL), orderSchema, 201);
  const sub = o.subOrders[0]!;
  const [l16, , l25] = sub.lines;
  await t.fixtures.addTruck({
    subOrderId: sub.id,
    state: 'dispatched',
    vehicleNo: 'CG 04 PQ 7781',
    tareKg: 12_020,
    plan: [{ orderLineId: l16!.id, plannedKg: 28_000 }],
    allocations: [{ orderLineId: l16!.id, netKg: 28_400 }],
  });
  await t.fixtures.addTruck({
    subOrderId: sub.id,
    state: 'loading',
    vehicleNo: 'CG 07 BR 8810',
    tareKg: 12_460,
    plan: [{ orderLineId: l16!.id, plannedKg: 6_000 }, { orderLineId: l25!.id, plannedKg: 20_000 }],
  });
  const fresh = expectOk(await call(t, 'GET', `/v1/orders/${o.id}`, { token: rajesh }), orderSchema);
  return { order: fresh, rajesh };
}

const shortClose = (t: ContractTarget, token: string, subId: string, version: number, cancelOpenTrucks = false) =>
  call(t, 'POST', `/v1/sub-orders/${subId}/short-close`, {
    token,
    body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks, version },
  });

export function register(factory: TargetFactory): void {
  describe('contract: order lifecycle', () => {
    const target = useTarget(factory);

    describe('edit limits (Review Focus 3)', () => {
      it('city staff: below dispatched → BELOW_DISPATCHED; rate of a dispatched line → LINE_RATE_LOCKED', async () => {
        const t = target();
        const { order } = await patelInProgress(t);
        const priya = await tokenFor(t, PEOPLE.priya);
        const base = editBody(order);
        const l16 = order.subOrders[0]!.lines[0]!.id;
        const below = expectError(
          await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: priya, body: withLine(base, 0, { orderedKg: 28_000 }) }),
          409,
          'BELOW_DISPATCHED',
        );
        expect(below.details).toEqual({ lineId: l16 });
        expectError(
          await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: priya, body: withLine(base, 0, { typedRate: 47_000 }) }),
          409,
          'LINE_RATE_LOCKED',
        );
      });

      it('owner may change that rate; nobody may go below dispatched', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        const base = editBody(order);
        expectError(
          await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: rajesh, body: withLine(base, 0, { orderedKg: 28_000 }) }),
          409,
          'BELOW_DISPATCHED',
        );
        const ok = expectOk(
          await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: rajesh, body: withLine(base, 0, { typedRate: 47_000 }) }),
          orderSchema,
        );
        expect(ok.subOrders[0]!.lines[0]).toMatchObject({ rate: 47_000, dispatchedKg: 28_400 });
        expect(ok.version).toBe(order.version + 1);
      });

      it('city staff changes undispatched lines and adds one; below dispatched + reserved only warns', async () => {
        const t = target();
        const { order } = await patelInProgress(t);
        const priya = await tokenFor(t, PEOPLE.priya);
        const body = withLine(editBody(order), 0, { orderedKg: 30_000 }); // 28.4 dispatched + 6 reserved
        body.subOrders[0]!.lines[2] = { ...body.subOrders[0]!.lines[2]!, orderedKg: 35_000, typedRate: 46_000 };
        body.subOrders[0]!.lines.push({
          id: undefined as unknown as string,
          productId: PR.tmt8,
          length: { value: 12, unit: 'm' },
          orderedKg: 10_000,
          typedRate: 46_200,
          overpricePerMt: 0,
        });
        const ok = expectOk(await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: priya, body }), orderSchema);
        expect(ok.subOrders[0]!.lines.map((l) => l.orderedKg)).toEqual([30_000, 50_000, 35_000, 10_000]);
        expect(ok.warnings).toEqual([{ lineId: order.subOrders[0]!.lines[0]!.id, code: 'BELOW_RESERVED' }]);
      });

      it('a stale version → 409 STALE and nothing changes', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        // Someone else saves first (version 1 → 2); this phone still holds version 1.
        expectOk(await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: rajesh, body: editBody(order) }), orderSchema);
        const stale = withLine(editBody(order), 1, { orderedKg: 55_000 });
        expectError(await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: rajesh, body: stale }), 409, 'STALE');
        const after = expectOk(await call(t, 'GET', `/v1/orders/${order.id}`, { token: rajesh }), orderSchema);
        expect(after.subOrders[0]!.lines[1]!.orderedKg).toBe(50_000);
      });
    });

    describe('short close (Review Focus 4)', () => {
      it('with a loading truck: first 409 OPEN_TRUCKS listing it; confirmed: trucks cancelled, sub-order short closed', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        const sub = order.subOrders[0]!;
        const err = expectError(await shortClose(t, rajesh, sub.id, sub.version), 409, 'OPEN_TRUCKS');
        expect(openTrucksDetailsSchema.parse(err.details).trucks).toEqual([
          expect.objectContaining({ vehicleNo: 'CG 07 BR 8810', state: 'loading', tareKg: 12_460 }),
        ]);
        const closed = expectOk(await shortClose(t, rajesh, sub.id, sub.version, true), orderSchema);
        const s = closed.subOrders[0]!;
        expect(s).toMatchObject({ status: 'short_closed', closeKind: 'short_close', closeReason: 'Customer stopped lifting', openTrucks: [] });
        expect(s.closedBy?.name).toBe('Rajesh Agrawal');
        expect(s.lines.map((l) => [l.closedKg, l.pendingKg, l.reservedKg])).toEqual([
          [11_600, 0, 0],
          [50_000, 0, 0],
          [30_000, 0, 0],
        ]);
        expect(closed.status).toBe('short_closed');
        expectError(await shortClose(t, rajesh, sub.id, s.version, true), 409, 'ALREADY_CLOSED');
      });

      it('a completed sub-order (nothing pending) cannot be short closed', async () => {
        const t = target();
        const rajesh = await tokenFor(t, PEOPLE.rajesh);
        const o = expectOk(await createOrder(t, rajesh, PATEL), orderSchema, 201);
        const sub = o.subOrders[0]!;
        await t.fixtures.addTruck({
          subOrderId: sub.id,
          state: 'dispatched',
          vehicleNo: 'CG 04 PQ 7781',
          tareKg: 12_020,
          plan: sub.lines.map((l) => ({ orderLineId: l.id, plannedKg: l.orderedKg })),
          allocations: sub.lines.map((l) => ({ orderLineId: l.id, netKg: l.orderedKg })),
        });
        const fresh = expectOk(await call(t, 'GET', `/v1/orders/${o.id}`, { token: rajesh }), orderSchema);
        expect(fresh.subOrders[0]!.status).toBe('completed');
        expectError(await shortClose(t, rajesh, sub.id, fresh.subOrders[0]!.version), 409, 'ALREADY_CLOSED');
      });

      it('nothing dispatched → recorded as Cancelled, not Short closed', async () => {
        const t = target();
        const priya = await tokenFor(t, PEOPLE.priya);
        const o = expectOk(await createOrder(t, priya, PATEL), orderSchema, 201);
        const closed = expectOk(await shortClose(t, priya, o.subOrders[0]!.id, o.subOrders[0]!.version), orderSchema);
        expect([closed.status, closed.subOrders[0]!.closeKind]).toEqual(['cancelled', 'cancel']);
      });

      it('reopen is owner only: Priya 403, Rajesh restores pending; reopening an open sub-order → NOT_CLOSED', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        const sub = order.subOrders[0]!;
        const closed = expectOk(await shortClose(t, rajesh, sub.id, sub.version, true), orderSchema).subOrders[0]!;
        const priya = await tokenFor(t, PEOPLE.priya);
        const reopen = (token: string, version: number) =>
          call(t, 'POST', `/v1/sub-orders/${sub.id}/reopen`, { token, body: { version } });
        expectError(await reopen(priya, closed.version), 403, 'FORBIDDEN');
        const back = expectOk(await reopen(rajesh, closed.version), orderSchema);
        expect(back.status).toBe('partly_dispatched');
        expect(back.subOrders[0]!.lines.map((l) => l.pendingKg)).toEqual([11_600, 50_000, 30_000]);
        expectError(await reopen(rajesh, back.subOrders[0]!.version), 409, 'NOT_CLOSED');
      });

      it('a closed sub-order cannot be edited until reopened (ORDER_LOCKED)', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        const sub = order.subOrders[0]!;
        const closed = expectOk(await shortClose(t, rajesh, sub.id, sub.version, true), orderSchema);
        expectError(
          await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: rajesh, body: withLine(editBody(closed), 1, { orderedKg: 60_000 }) }),
          409,
          'ORDER_LOCKED',
        );
      });
    });

    describe('move quantity', () => {
      it('10 MT of AIP 12 mm to KRM: AIP line −10 MT, a matching KRM line +10 MT, order total unchanged', async () => {
        const t = target();
        const rajesh = await tokenFor(t, PEOPLE.rajesh);
        const o = expectOk(await createOrder(t, rajesh, CANVAS_ORDER), orderSchema, 201);
        const from = o.subOrders[0]!.lines[0]!;
        const moved = expectOk(
          await call(t, 'POST', `/v1/orders/${o.id}/move-quantity`, {
            token: rajesh,
            body: { fromLineId: from.id, toCompanyId: COMPANY.KRM, kg: 10_000, version: o.version },
          }),
          orderSchema,
        );
        expect(moved.subOrders[0]!.lines[0]!.orderedKg).toBe(14_000);
        const krmLines = moved.subOrders[1]!.lines;
        expect(krmLines[1]).toMatchObject({ productId: PR.tmt12, length: { value: 12, unit: 'm' }, orderedKg: 10_000, rate: 46_000, overpricePerMt: 300 });
        expect(moved.totals.orderedKg).toBe(84_000);
        expect(moved.estimatedValue).toBe(o.estimatedValue);
        const acts = expectOk(
          await call(t, 'GET', `/v1/orders/${o.id}/activity`, { token: rajesh }),
          z.array(activityEntrySchema),
        );
        expect(acts[0]).toMatchObject({ action: 'order.quantity_moved', actorName: 'Rajesh Agrawal', meta: { kg: 10_000 } });
      });

      it('more than available → MOVE_EXCEEDS_AVAILABLE with availableKg; a company that does not make it → 409', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        const l16 = order.subOrders[0]!.lines[0]!; // 40 ordered, 28.4 dispatched, 6 reserved → 5.6 available
        const move = (kg: number, toCompanyId: string) =>
          call(t, 'POST', `/v1/orders/${order.id}/move-quantity`, {
            token: rajesh,
            body: { fromLineId: l16.id, toCompanyId, kg, version: order.version },
          });
        const err = expectError(await move(6_000, COMPANY.AIP), 409, 'MOVE_EXCEEDS_AVAILABLE');
        expect(err.details).toEqual({ availableKg: 5_600 });
        expectError(await move(1_000, COMPANY.NAP), 409, 'PRODUCT_NOT_FOR_COMPANY');
        const ok = expectOk(await move(5_600, COMPANY.AIP), orderSchema);
        expect(ok.subOrders.map((s) => [s.suffix, s.companyCode])).toEqual([['A', 'KRM'], ['B', 'AIP']]);
      });
    });

    describe('activity scope', () => {
      it('a plant head sees no history about sub-orders outside their plants', async () => {
        const t = target();
        const rajesh = await tokenFor(t, PEOPLE.rajesh);
        const o = expectOk(await createOrder(t, rajesh, CANVAS_ORDER), orderSchema, 201);
        const aip = o.subOrders.find((s) => s.companyId === COMPANY.AIP)!;
        const krm = o.subOrders.find((s) => s.companyId === COMPANY.KRM)!;
        const moved = expectOk(
          await call(t, 'POST', `/v1/orders/${o.id}/move-quantity`, {
            token: rajesh,
            body: { fromLineId: aip.lines[0]!.id, toCompanyId: COMPANY.KRM, kg: 1_000, version: o.version },
          }),
          orderSchema,
        );
        const krmNow = moved.subOrders.find((s) => s.id === krm.id)!;
        expectOk(await shortClose(t, rajesh, krm.id, krmNow.version, true), orderSchema);
        const all = expectOk(await call(t, 'GET', `/v1/orders/${o.id}/activity`, { token: rajesh }), z.array(activityEntrySchema));
        const aboutKrm = (e: { meta?: Record<string, unknown> }) => e.meta?.subOrderId === krm.id || e.meta?.toSubOrderId === krm.id;
        expect(all.filter(aboutKrm).map((e) => e.action)).toEqual(['order.sub_cancelled', 'order.quantity_moved']);
        const kiran = await tokenFor(t, PEOPLE.kiran);
        const seen = expectOk(await call(t, 'GET', `/v1/orders/${o.id}/activity`, { token: kiran }), z.array(activityEntrySchema));
        expect(seen.map((e) => e.action)).toContain('order.created');
        expect(seen.filter(aboutKrm)).toEqual([]);
        expect(seen.map((e) => e.action)).not.toContain('order.quantity_moved');
      });
    });

    describe('hard delete', () => {
      it('preview counts, typed confirmation, owner only; afterwards nothing is left', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        const preview = expectOk(await call(t, 'GET', `/v1/orders/${order.id}/delete-preview`, { token: rajesh }), deletePreviewSchema);
        expect(preview).toEqual({ subOrders: 1, lines: 3, trucks: 2, dispatchedKg: 28_400, weighments: 3 });
        const del = (token: string, confirmNumber: string) =>
          call(t, 'DELETE', `/v1/orders/${order.id}`, { token, body: { confirmNumber } });
        expectError(await del(await tokenFor(t, PEOPLE.priya), order.number), 403, 'FORBIDDEN');
        expectError(await del(rajesh, 'SO-2611-9999'), 409, 'CONFIRMATION_MISMATCH');
        expect((await del(rajesh, ` ${order.number.toLowerCase()} `)).status).toBe(204);
        expectError(await call(t, 'GET', `/v1/orders/${order.id}`, { token: rajesh }), 404, 'NOT_FOUND');
        expectError(await call(t, 'GET', `/v1/orders/${order.id}/activity`, { token: rajesh }), 404, 'NOT_FOUND');
        // Its products are free to delete again: no line refers to them any more.
        expect((await call(t, 'DELETE', `/v1/products/${PR.tmt25}`, { token: rajesh })).status).toBe(204);
      });

      it('with allowHardDeleteAfterDispatch off, an order with dispatches cannot be deleted', async () => {
        const t = target();
        const { order, rajesh } = await patelInProgress(t);
        expect((await call(t, 'PATCH', '/v1/settings', { token: rajesh, body: { allowHardDeleteAfterDispatch: false } })).status).toBe(200);
        expectError(
          await call(t, 'DELETE', `/v1/orders/${order.id}`, { token: rajesh, body: { confirmNumber: order.number } }),
          409,
          'HARD_DELETE_DISABLED',
        );
        const fresh = expectOk(await createOrder(t, rajesh, PATEL), orderSchema, 201);
        expect((await call(t, 'DELETE', `/v1/orders/${fresh.id}`, { token: rajesh, body: { confirmNumber: fresh.number } })).status).toBe(204);
      });
    });

    it('create keys are not shared across routes: duplicate with a create key is refused', async () => {
      const t = target();
      const rajesh = await tokenFor(t, PEOPLE.rajesh);
      const key = newKey();
      const o = expectOk(await call(t, 'POST', '/v1/orders', { token: rajesh, idempotencyKey: key, body: CANVAS_ORDER }), orderSchema, 201);
      expectError(await call(t, 'POST', `/v1/orders/${o.id}/duplicate`, { token: rajesh, idempotencyKey: key }), 422, 'VALIDATION');
    });
  });
}
