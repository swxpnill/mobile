import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Rejection,
  type Truck,
  activityEntrySchema,
  orderSchema,
  rejectionCountSchema,
  rejectionSchema,
  restoreRejectionResultSchema,
  truckSchema,
} from '@tonnage/shared';
import {
  COMPANY,
  MINUTE,
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
import { assign, canvasWithTruck, getOrder, getTruck, lineIn, phone, sync, synced } from './sync.contract.ts';

const rejectionList = z.array(rejectionSchema);

const list = async (t: ContractTarget, token: string, status?: 'open' | 'all') =>
  expectOk(
    await call(t, 'GET', `/v1/weighment-rejections${status === undefined ? '' : `?status=${status}`}`, { token }),
    rejectionList,
  );
const openCount = async (t: ContractTarget, token: string) =>
  expectOk(await call(t, 'GET', '/v1/weighment-rejections/count', { token }), rejectionCountSchema).open;
// Every write carries an Idempotency-Key (spec: a stored replay for every mutating request).
const restore = (t: ContractTarget, token: string, id: string, key = newKey()) =>
  call(t, 'POST', `/v1/weighment-rejections/${id}/restore`, { token, idempotencyKey: key });
const dismiss = (t: ContractTarget, token: string, id: string, reason: string, key = newKey()) =>
  call(t, 'POST', `/v1/weighment-rejections/${id}/dismiss`, { token, idempotencyKey: key, body: { reason } });
const correct = (t: ContractTarget, token: string, truck: Truck, body: Record<string, unknown>, key = newKey()) =>
  call(t, 'POST', `/v1/trucks/${truck.id}/correct-weight`, {
    token,
    idempotencyKey: key,
    body: { reason: 'Weighbridge recalibrated', version: truck.version, ...body },
  });
const activityOf = async (t: ContractTarget, token: string, orderId: string) =>
  expectOk(await call(t, 'GET', `/v1/orders/${orderId}/activity`, { token }), z.array(activityEntrySchema));

/** The canvas truck: tare saved offline, the owner cancels it, then Ravi's phone syncs tare + gross. */
async function cancelledBeforeSync(t: ContractTarget, grossNetKg = 24_180) {
  const base = await canvasWithTruck(t);
  const { owner, aLine, truck } = base;
  const ravi = await tokenFor(t, PEOPLE.ravi);
  const p = phone(truck.id, () => t.clock.now());
  const events = [p.tare(12_460), p.gross(12_460 + 24_180, [{ orderLineId: aLine.id, netKg: grossNetKg }])];
  expectOk(
    await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, {
      idempotencyKey: newKey(),
      token: owner,
      body: { reason: 'Vehicle did not arrive', note: '', version: truck.version },
    }),
    truckSchema,
  );
  const results = await synced(sync(t, ravi, events));
  return { ...base, ravi, events, results };
}

/** One sub-order, one 24 MT line (12 mm · 12 m), and a truck dispatched with `netKg` on it. */
async function singleLineDispatched(t: ContractTarget, netKg: number) {
  const owner = await tokenFor(t, PEOPLE.rajesh);
  const first = CANVAS_ORDER.subOrders[0]!;
  const body = { ...CANVAS_ORDER, subOrders: [{ companyId: COMPANY.AIP, lines: [first.lines[0]!] }] };
  const order = expectOk(await createOrder(t, owner, body), orderSchema, 201);
  const sub = order.subOrders[0]!;
  const line = sub.lines[0]!;
  const truck = await assign(t, owner, sub.id, line.id, 24_000);
  const ravi = await tokenFor(t, PEOPLE.ravi);
  const p = phone(truck.id, () => t.clock.now());
  const r = await synced(sync(t, ravi, [p.tare(12_000), p.gross(12_000 + netKg, [{ orderLineId: line.id, netKg }])]));
  expect(r.map((x) => x.status)).toEqual(['accepted', 'accepted']);
  return { owner, order, sub, line, truck: await getTruck(t, owner, truck.id) };
}

export function register(factory: TargetFactory): void {
  describe('contract: needs attention and weight correction', () => {
    const target = useTarget(factory);
    let startedAt = 0;
    beforeEach(() => {
      startedAt = target().clock.now();
    });
    afterEach(() => {
      const t = target();
      t.clock.advance(startedAt - t.clock.now());
    });

    describe('needs attention', () => {
      it('cancelled before sync: both events listed once; restoring the tare reinstates and dispatches the truck', async () => {
        const t = target();
        const { owner, ravi, aLine, truck, events, results } = await cancelledBeforeSync(t);
        expect(results.map((r) => (r.status === 'rejected' ? r.code : r.status))).toEqual(['TRUCK_CANCELLED', 'INVALID_STATE']);

        const open = await list(t, owner);
        expect(open.map((r) => r.eventType)).toEqual(['GROSS', 'TARE']); // newest first
        expect(open.filter((r) => r.truckId === truck.id)).toHaveLength(2);
        const [gross, tare] = open as [Rejection, Rejection];
        expect(tare).toMatchObject({
          truckId: truck.id,
          vehicleNo: 'CG 04 MK 2291',
          plantName: 'Siltara',
          subOrderNumber: truck.subOrderNumber,
          user: { id: PEOPLE.ravi.id, name: 'Ravi Verma' },
          eventType: 'TARE',
          payload: { tareKg: 12_460 },
          code: 'TRUCK_CANCELLED',
          serverState: 'cancelled',
          status: 'open',
          resolvedBy: null,
          resolutionNote: null,
        });
        expect(gross).toMatchObject({
          eventType: 'GROSS',
          code: 'INVALID_STATE',
          payload: { grossKg: 36_640, allocations: [{ orderLineId: aLine.id, netKg: 24_180 }] },
        });
        expect(await openCount(t, owner)).toBe(2);

        const restored = expectOk(await restore(t, owner, tare.id), restoreRejectionResultSchema);
        expect(restored.rejection).toMatchObject({ id: tare.id, status: 'restored', resolvedBy: { id: PEOPLE.rajesh.id } });
        expect(restored.truck).toMatchObject({ id: truck.id, state: 'dispatched', tareKg: 12_460, grossKg: 36_640, netKg: 24_180 });
        expect(restored.truck.loadingSlipNo).toMatch(/^LS-AIP-\d{4}-\d{4}$/);
        expect(restored.truck.cancelledAt).toBeNull();

        // Both resolved, nothing open; the weights stand as Ravi's.
        expect(await list(t, owner)).toEqual([]);
        expect(await openCount(t, owner)).toBe(0);
        const all = await list(t, owner, 'all');
        expect(all.map((r) => [r.eventType, r.status])).toEqual([
          ['GROSS', 'restored'],
          ['TARE', 'restored'],
        ]);
        const detail = await getTruck(t, owner, truck.id);
        expect(detail.weighments.map((w) => [w.kind, w.kg, w.by.name, w.superseded])).toEqual([
          ['tare', 12_460, 'Ravi Verma', false],
          ['gross', 36_640, 'Ravi Verma', false],
        ]);
        expect(detail.loadingSlipNo).toBe(restored.truck.loadingSlipNo);

        // The phone pushing the same outbox again changes nothing.
        expect((await synced(sync(t, ravi, events))).map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
        expectError(await restore(t, owner, tare.id), 409, 'ALREADY_RESOLVED');
        expectError(await restore(t, owner, gross.id), 409, 'ALREADY_RESOLVED');
      });

      it('a restore refused again is 409 with that code: everything rolls back and the rejections stay open', async () => {
        const t = target();
        // The gross split is 1 kg short of the net, so it is refused again once the truck is back.
        const { owner, truck } = await cancelledBeforeSync(t, 24_179);
        const tare = (await list(t, owner)).find((r) => r.eventType === 'TARE')!;

        expectError(await restore(t, owner, tare.id), 409, 'ALLOC_MISMATCH');
        expect((await list(t, owner)).map((r) => r.status)).toEqual(['open', 'open']);
        const detail = await getTruck(t, owner, truck.id);
        expect(detail).toMatchObject({ state: 'cancelled', tareKg: null, weighments: [] });
      });

      it('restore of a refusal on a live truck re-runs it: ALLOC_MISMATCH again stays open', async () => {
        const t = target();
        const { owner, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        await synced(sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_000 }])]));
        const [rej] = await list(t, owner);
        expect(rej).toMatchObject({ eventType: 'GROSS', code: 'ALLOC_MISMATCH', serverState: 'loading' });
        expectError(await restore(t, owner, rej!.id), 409, 'ALLOC_MISMATCH');
        expect(await openCount(t, owner)).toBe(1);
        expect((await getTruck(t, owner, truck.id)).state).toBe('loading');
      });

      it('dismiss needs a reason of 3 characters; a resolved rejection cannot be resolved again', async () => {
        const t = target();
        const { owner } = await cancelledBeforeSync(t);
        const [gross, tare] = (await list(t, owner)) as [Rejection, Rejection];

        expectError(await dismiss(t, owner, gross.id, ' ok '), 422, 'VALIDATION');
        const done = expectOk(await dismiss(t, owner, gross.id, 'Truck went back empty'), rejectionSchema);
        expect(done).toMatchObject({
          id: gross.id,
          status: 'dismissed',
          resolutionNote: 'Truck went back empty',
          resolvedBy: { id: PEOPLE.rajesh.id, name: 'Rajesh Agrawal' },
        });
        expectError(await dismiss(t, owner, gross.id, 'Again please'), 409, 'ALREADY_RESOLVED');
        expectError(await restore(t, owner, gross.id), 409, 'ALREADY_RESOLVED');
        expect((await list(t, owner)).map((r) => r.id)).toEqual([tare.id]);
        expect(await openCount(t, owner)).toBe(1);

        // Restoring the tare alone: the truck is back in loading with it, not dispatched.
        const r = expectOk(await restore(t, owner, tare.id), restoreRejectionResultSchema);
        expect(r.truck).toMatchObject({ state: 'loading', tareKg: 12_460, grossKg: null });
      });

      it('a truck cancelled by closing its sub-order: restore is ORDER_LOCKED until the sub-order is reopened', async () => {
        const t = target();
        const { owner, order, a, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        expectOk(
          await call(t, 'POST', `/v1/sub-orders/${a.id}/short-close`, {
            token: owner,
            body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: a.version },
          }),
          orderSchema,
        );
        await synced(sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])]));
        const tare = (await list(t, owner)).find((r) => r.eventType === 'TARE')!;
        expectError(await restore(t, owner, tare.id), 409, 'ORDER_LOCKED');
        expect(await openCount(t, owner)).toBe(2);

        const closed = (await getOrder(t, owner, order.id)).subOrders[0]!;
        expectOk(await call(t, 'POST', `/v1/sub-orders/${a.id}/reopen`, { token: owner, body: { version: closed.version } }), orderSchema);
        const r = expectOk(await restore(t, owner, tare.id), restoreRejectionResultSchema);
        expect(r.truck).toMatchObject({ state: 'dispatched', netKg: 24_180 });
        expect(await openCount(t, owner)).toBe(0);
      });

      it("a restored weight keeps its sync's clock correction: phone 10 minutes behind", async () => {
        const t = target();
        const { owner, truck } = await canvasWithTruck(t);
        expectOk(
          await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, { token: owner, idempotencyKey: newKey(), body: { reason: 'Other', note: '', version: truck.version } }),
          truckSchema,
        );
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const behind = 10 * MINUTE;
        const weighedAt = t.clock.now() - MINUTE;
        const p = phone(truck.id, () => weighedAt - behind);
        await synced(sync(t, ravi, [p.tare(12_460)], { deviceTime: t.clock.now() - behind }));
        const [rej] = await list(t, owner);

        t.clock.advance(5 * MINUTE);
        const r = expectOk(await restore(t, owner, rej!.id), restoreRejectionResultSchema);
        expect(r.truck.weighments).toMatchObject([{ kind: 'tare', clockSkew: true, capturedAt: new Date(weighedAt).toISOString() }]);
      });

      it('owner only: city staff, plant heads and supervisors get 403; an unknown id is 404', async () => {
        const t = target();
        const { owner } = await cancelledBeforeSync(t);
        const [rej] = await list(t, owner);
        for (const who of [PEOPLE.priya, PEOPLE.kiran, PEOPLE.ravi]) {
          const token = await tokenFor(t, who);
          expectError(await call(t, 'GET', '/v1/weighment-rejections', { token }), 403, 'FORBIDDEN');
          expectError(await call(t, 'GET', '/v1/weighment-rejections/count', { token }), 403, 'FORBIDDEN');
          expectError(await restore(t, token, rej!.id), 403, 'FORBIDDEN');
          expectError(await dismiss(t, token, rej!.id, 'Not mine'), 403, 'FORBIDDEN');
        }
        expectError(await restore(t, owner, RANDOM_ID), 404, 'NOT_FOUND');
        expectError(await dismiss(t, owner, RANDOM_ID, 'Nothing here'), 404, 'NOT_FOUND');
        expect(await openCount(t, owner)).toBe(2);
        expect((await call(t, 'GET', '/v1/weighment-rejections?status=closed', { token: owner })).status).toBe(422);
      });
    });

    describe('replay (Idempotency-Key)', () => {
      it('restore and dismiss replayed with the same key answer the same 200 and change nothing again', async () => {
        const t = target();
        const { owner, truck } = await cancelledBeforeSync(t);
        const [gross, tare] = (await list(t, owner)) as [Rejection, Rejection];

        const dKey = newKey();
        const d1 = await dismiss(t, owner, gross.id, 'Truck went back empty', dKey);
        const d2 = await dismiss(t, owner, gross.id, 'Truck went back empty', dKey);
        expect(d1.status).toBe(200);
        expect(d2.status).toBe(200);
        expect(d2.body).toEqual(d1.body);

        const rKey = newKey();
        const r1 = await restore(t, owner, tare.id, rKey);
        const r2 = await restore(t, owner, tare.id, rKey);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r2.body).toEqual(r1.body);
        const after = await getTruck(t, owner, truck.id);
        expect(after).toMatchObject({ state: 'loading', version: expectOk(r1, restoreRejectionResultSchema).truck.version });
        expect(after.weighments.filter((w) => !w.superseded)).toHaveLength(1);
        expect((await list(t, owner, 'all')).map((r) => r.status)).toEqual(['dismissed', 'restored']);
      });

      it('restore, dismiss and correct-weight without an Idempotency-Key: 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
        const t = target();
        const { owner, aLine, truck } = await cancelledBeforeSync(t);
        const [rej] = await list(t, owner);
        expectError(await call(t, 'POST', `/v1/weighment-rejections/${rej!.id}/restore`, { token: owner }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
        expectError(
          await call(t, 'POST', `/v1/weighment-rejections/${rej!.id}/dismiss`, { token: owner, body: { reason: 'No key here' } }),
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
        );
        expectError(
          await call(t, 'POST', `/v1/trucks/${truck.id}/correct-weight`, {
            token: owner,
            body: { tareKg: 12_000, grossKg: 30_000, allocations: [{ orderLineId: aLine.id, netKg: 18_000 }], reason: 'No key here', version: 1 },
          }),
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
        );
        expect(await openCount(t, owner)).toBe(2);
      });
    });

    describe('weight correction', () => {
      it('24.180 → 22.000 MT: weighments superseded, dispatched kg and earning rewritten, activity logged', async () => {
        const t = target();
        const { owner, order, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        await synced(sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])]));
        const before = await getTruck(t, owner, truck.id);
        expect(before.earningRupees).toBe(10_881);

        const res = await correct(t, owner, before, {
          tareKg: 12_460,
          grossKg: 34_460,
          allocations: [{ orderLineId: aLine.id, netKg: 22_000 }],
        });
        const after = expectOk(res, truckSchema);
        // Σ of earning, its exact reversal and the new earning: 22.000 MT × ₹450 (rates at dispatch).
        expect(after).toMatchObject({ state: 'dispatched', netKg: 22_000, grossKg: 34_460, earningRupees: 9_900 });
        expect(after.version).toBeGreaterThan(before.version);
        expect(after.loadingSlipNo).toBe(before.loadingSlipNo);
        expect(after.dispatchedAt).toBe(before.dispatchedAt);
        expect(after.allocations).toEqual([{ orderLineId: aLine.id, netKg: 22_000 }]);
        expect(after.weighments.map((w) => [w.kind, w.kg, w.by.name, w.superseded])).toEqual([
          ['tare', 12_460, 'Ravi Verma', true],
          ['gross', 36_640, 'Ravi Verma', true],
          ['tare', 12_460, 'Rajesh Agrawal', false],
          ['gross', 34_460, 'Rajesh Agrawal', false],
        ]);
        expect(lineIn(await getOrder(t, owner, order.id), aLine.id).dispatchedKg).toBe(22_000);

        const log = await activityOf(t, owner, order.id);
        expect(log.find((e) => e.action === 'truck.weight_corrected')?.meta).toMatchObject({
          subOrderId: truck.subOrderId,
          truckId: truck.id,
          oldNetKg: 24_180,
          newNetKg: 22_000,
          reason: 'Weighbridge recalibrated',
        });

        // A stale version is refused.
        expectError(
          await correct(t, owner, before, { tareKg: 12_460, grossKg: 34_460, allocations: [{ orderLineId: aLine.id, netKg: 22_000 }] }),
          409,
          'STALE',
        );
      });

      it('a correction replayed with the same key answers the same 200: one reversal and one new earning', async () => {
        const t = target();
        const { owner, order, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        await synced(sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])]));
        const before = await getTruck(t, owner, truck.id);
        const body = { tareKg: 12_460, grossKg: 34_460, allocations: [{ orderLineId: aLine.id, netKg: 22_000 }] };
        const key = newKey();
        const first = await correct(t, owner, before, body, key);
        const again = await correct(t, owner, before, body, key);
        expect(first.status).toBe(200);
        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
        const now = await getTruck(t, owner, truck.id);
        expect(now).toMatchObject({ netKg: 22_000, earningRupees: 9_900, version: before.version + 1 });
        expect(now.weighments).toHaveLength(4); // two superseded, two new: not six
        const log = await activityOf(t, owner, order.id);
        expect(log.filter((e) => e.action === 'truck.weight_corrected')).toHaveLength(1);
      });

      it('a tolerance-completed sub-order corrected down by 2 MT is partly dispatched again; back up, it closes again', async () => {
        const t = target();
        const { owner, order, line, truck } = await singleLineDispatched(t, 23_400);
        const subOf = async () => (await getOrder(t, owner, order.id)).subOrders[0]!;
        expect(await subOf()).toMatchObject({ status: 'completed', closeKind: 'tolerance' });

        const down = expectOk(
          await correct(t, owner, truck, { tareKg: 12_000, grossKg: 33_400, allocations: [{ orderLineId: line.id, netKg: 21_400 }] }),
          truckSchema,
        );
        const reopened = await subOf();
        expect(reopened).toMatchObject({ status: 'partly_dispatched', closeKind: null });
        expect(reopened.lines[0]).toMatchObject({ dispatchedKg: 21_400, closedKg: 0 });

        expectOk(
          await correct(t, owner, down, { tareKg: 12_000, grossKg: 35_500, allocations: [{ orderLineId: line.id, netKg: 23_500 }] }),
          truckSchema,
        );
        const closed = await subOf();
        expect(closed).toMatchObject({ status: 'completed', closeKind: 'tolerance' });
        expect(closed.lines[0]).toMatchObject({ dispatchedKg: 23_500, closedKg: 500 });
      });

      it('a gross more than 1 MT over the order logs order.over_tolerance with the kg', async () => {
        const t = target();
        const { owner, order, sub } = await singleLineDispatched(t, 25_500);
        const e = (await activityOf(t, owner, order.id)).find((x) => x.action === 'order.over_tolerance');
        expect(e?.meta).toEqual({ subOrderId: sub.id, kg: 1_500 });
      });

      it('refusals: city staff 403, not dispatched TRUCK_LOCKED, bad weights 409, short reason 422, unknown 404', async () => {
        const t = target();
        const { owner, aLine, truck } = await canvasWithTruck(t);
        const good = { tareKg: 12_460, grossKg: 34_460, allocations: [{ orderLineId: aLine.id, netKg: 22_000 }] };
        expectError(await correct(t, owner, truck, good), 409, 'TRUCK_LOCKED');

        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        await synced(sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])]));
        const dispatched = await getTruck(t, owner, truck.id);

        for (const who of [PEOPLE.priya, PEOPLE.kiran, PEOPLE.ravi]) {
          expectError(await correct(t, await tokenFor(t, who), dispatched, good), 403, 'FORBIDDEN');
        }
        expectError(await correct(t, owner, dispatched, { ...good, grossKg: 12_460, allocations: [{ orderLineId: aLine.id, netKg: 0 }] }), 409, 'INVALID_WEIGHT');
        expectError(await correct(t, owner, dispatched, { ...good, allocations: [{ orderLineId: aLine.id, netKg: 21_999 }] }), 409, 'ALLOC_MISMATCH');
        expectError(await correct(t, owner, dispatched, { ...good, allocations: [{ orderLineId: RANDOM_ID, netKg: 22_000 }] }), 409, 'LINE_REMOVED');
        expectError(await correct(t, owner, dispatched, { ...good, reason: 'no' }), 422, 'VALIDATION');
        expectError(
          await call(t, 'POST', `/v1/trucks/${RANDOM_ID}/correct-weight`, { token: owner, idempotencyKey: newKey(), body: { ...good, reason: 'Recheck', version: 1 } }),
          404,
          'NOT_FOUND',
        );
        expect(await getTruck(t, owner, truck.id)).toMatchObject({ netKg: 24_180, earningRupees: 10_881, version: dispatched.version });
      });
    });
  });
}
