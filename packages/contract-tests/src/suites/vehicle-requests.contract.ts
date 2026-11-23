import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Order,
  SAMPLE_MASTERS,
  activityEntrySchema,
  orderSchema,
  validationDetailsSchema,
  vehicleRequestSchema,
} from '@tonnage/shared';
import {
  MINUTE,
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
import { createOrder } from './orders.contract.ts';
import { assign, getOrder } from './sync.contract.ts';

const P = SAMPLE_MASTERS.ids.parties;
const created = z.object({ request: vehicleRequestSchema }).strict();
const activity = z.array(activityEntrySchema);

type Line = { orderLineId: string; kg: number };

/** R.K. Agarwal (the canvas order's broker) on his WhatsApp number. */
const body = (lines: Line[], over: Record<string, unknown> = {}) => ({
  partyId: P.rkAgarwal,
  contactName: 'R.K. Agarwal',
  number: '+919826100501',
  channel: 'whatsapp',
  lines,
  totalKg: lines.reduce((s, l) => s + l.kg, 0),
  ...over,
});

const post = (t: ContractTarget, token: string, orderId: string, b: unknown, idempotencyKey = newKey()) =>
  call(t, 'POST', `/v1/orders/${orderId}/vehicle-requests`, { token, idempotencyKey, body: b });

const paths = (res: { body: unknown }) =>
  validationDetailsSchema.parse((res.body as { details: unknown }).details).map((d) => d.path);

/** The canvas order (AIP = A: 24 / 10 / 20 MT, KRM = B: 30 MT), Shubham Traders via R.K. Agarwal. */
async function canvas(t: ContractTarget) {
  const owner = await tokenFor(t, PEOPLE.rajesh);
  const order = expectOk(await createOrder(t, owner), orderSchema, 201);
  return { owner, order, a: order.subOrders[0]!, b: order.subOrders[1]! };
}

const shortClose = async (t: ContractTarget, token: string, o: Order, subId: string) => {
  const sub = (await getOrder(t, token, o.id)).subOrders.find((s) => s.id === subId)!;
  return call(t, 'POST', `/v1/sub-orders/${subId}/short-close`, {
    idempotencyKey: newKey(),
    token,
    body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: sub.version },
  });
};

export function register(factory: TargetFactory): void {
  describe('contract: vehicle requests', () => {
    const target = useTarget(factory);

    it('vehicle request: owner records one; the order lists it open and its status is unchanged', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      const line = a.lines[0]!;
      const res = expectOk(await post(t, owner, order.id, body([{ orderLineId: line.id, kg: 24_000 }])), created, 201);
      expect(res.request).toMatchObject({
        partyId: P.rkAgarwal,
        partyName: 'R.K. Agarwal',
        contactName: 'R.K. Agarwal',
        number: '+919826100501',
        channel: 'whatsapp',
        lines: [{ orderLineId: line.id, subOrderId: a.id, kg: 24_000 }],
        totalKg: 24_000,
        requestedAt: new Date(t.clock.now()).toISOString(),
        requestedBy: { id: PEOPLE.rajesh.id, name: 'Rajesh Agrawal' },
      });
      const after = await getOrder(t, owner, order.id);
      expect(after.vehicleRequests).toEqual([res.request]);
      expect(after.status).toBe(order.status);
      expect(after.version).toBe(order.version);
      expect(after.subOrders[0]!.lines[0]).toMatchObject({ pendingKg: 24_000, reservedKg: 0 });
    });

    it('vehicle request: a replay with the same Idempotency-Key is the same answer and one activity row', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      const key = newKey();
      const b = body([{ orderLineId: a.lines[1]!.id, kg: 10_000 }]);
      const first = await post(t, owner, order.id, b, key);
      const second = await post(t, owner, order.id, b, key);
      expect(first.status).toBe(201);
      expect({ status: second.status, body: second.body }).toEqual({ status: first.status, body: first.body });
      expect(second.headers['idempotent-replay']).toBe('true');
      const acts = expectOk(await call(t, 'GET', `/v1/orders/${order.id}/activity`, { token: owner }), activity);
      expect(acts.filter((e) => e.action === 'order.vehicle_requested')).toHaveLength(1);
      expect((await getOrder(t, owner, order.id)).vehicleRequests).toHaveLength(1);
    });

    it('vehicle request: city staff may record one; a supervisor and a plant head get 403', async () => {
      const t = target();
      const { order, a } = await canvas(t);
      const b = body([{ orderLineId: a.lines[0]!.id, kg: 5_000 }]);
      expectOk(await post(t, await tokenFor(t, PEOPLE.priya), order.id, b), created, 201);
      expectError(await post(t, await tokenFor(t, PEOPLE.ravi), order.id, b), 403, 'FORBIDDEN');
      expectError(await post(t, await tokenFor(t, PEOPLE.kiran), order.id, b), 403, 'FORBIDDEN');
    });

    it('vehicle request: kg above pending, or a line of another order, is 422 at that line', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      const other = expectOk(await createOrder(t, owner), orderSchema, 201);
      const above = await post(t, owner, order.id, body([{ orderLineId: a.lines[0]!.id, kg: 24_001 }]));
      expectError(above, 422, 'VALIDATION');
      expect(paths(above)).toEqual([['lines', 0, 'kg']]);
      const foreign = await post(t, owner, order.id, body([{ orderLineId: other.subOrders[0]!.lines[0]!.id, kg: 1_000 }]));
      expectError(foreign, 422, 'VALIDATION');
      expect(paths(foreign)).toEqual([['lines', 0, 'orderLineId']]);
      expect((await getOrder(t, owner, order.id)).vehicleRequests).toEqual([]);
    });

    it('vehicle request: a line on a closed sub-order is 422 at its kg', async () => {
      const t = target();
      const { owner, order, b } = await canvas(t);
      expect((await shortClose(t, owner, order, b.id)).status).toBe(200);
      const res = await post(t, owner, order.id, body([{ orderLineId: b.lines[0]!.id, kg: 1_000 }]));
      expectError(res, 422, 'VALIDATION');
      expect(paths(res)).toEqual([['lines', 0, 'kg']]);
    });

    it('vehicle request: totalKg must be the sum, and the party must be on the order', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      const lines = [{ orderLineId: a.lines[0]!.id, kg: 4_000 }];
      const total = await post(t, owner, order.id, body(lines, { totalKg: 5_000 }));
      expectError(total, 422, 'VALIDATION');
      expect(paths(total)).toEqual([['totalKg']]);
      const party = await post(t, owner, order.id, body(lines, { partyId: P.mittal, contactName: 'Sunil Mittal', number: '+919826100502' }));
      expectError(party, 422, 'VALIDATION');
      expect(paths(party)).toEqual([['partyId']]);
      // The customer is on the order too.
      expectOk(await post(t, owner, order.id, body(lines, { partyId: P.shubham, channel: 'call' })), created, 201);
    });

    it("vehicle request: another tenant's order is 404", async () => {
      const t = target();
      const { order, a } = await canvas(t);
      const other = await t.fixtures.createTenant('Other Group');
      const theirs = await tokenFor(t, { mobile: other.ownerMobile });
      expectError(await post(t, theirs, order.id, body([{ orderLineId: a.lines[0]!.id, kg: 1_000 }])), 404, 'NOT_FOUND');
    });

    it('vehicle request: a truck assigned before it leaves it open; one assigned after closes it', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      const line = a.lines[0]!;
      await assign(t, owner, a.id, line.id, 5_000, 'CG 04 AA 1111');
      t.clock.advance(MINUTE);
      expectOk(await post(t, owner, order.id, body([{ orderLineId: line.id, kg: 19_000 }])), created, 201);
      expect((await getOrder(t, owner, order.id)).vehicleRequests).toHaveLength(1);
      t.clock.advance(MINUTE);
      await assign(t, owner, a.id, line.id, 5_000, 'CG 04 BB 2222');
      expect((await getOrder(t, owner, order.id)).vehicleRequests).toEqual([]);
    });

    it('vehicle request: short close clears it; with lines on two sub-orders it stays open until both are closed', async () => {
      const t = target();
      const { owner, order, a, b } = await canvas(t);
      const req = body([
        { orderLineId: a.lines[1]!.id, kg: 10_000 },
        { orderLineId: b.lines[0]!.id, kg: 30_000 },
      ]);
      expectOk(await post(t, owner, order.id, req), created, 201);
      t.clock.advance(MINUTE);
      expect((await shortClose(t, owner, order, b.id)).status).toBe(200);
      expect((await getOrder(t, owner, order.id)).vehicleRequests).toHaveLength(1);
      expect((await shortClose(t, owner, order, a.id)).status).toBe(200);
      expect((await getOrder(t, owner, order.id)).vehicleRequests).toEqual([]);
    });

    it('vehicle request: open requests are listed newest first', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      const first = expectOk(await post(t, owner, order.id, body([{ orderLineId: a.lines[0]!.id, kg: 1_000 }])), created, 201);
      t.clock.advance(MINUTE);
      const second = expectOk(await post(t, owner, order.id, body([{ orderLineId: a.lines[2]!.id, kg: 2_000 }])), created, 201);
      expect((await getOrder(t, owner, order.id)).vehicleRequests.map((r) => r.id)).toEqual([second.request.id, first.request.id]);
    });

    it('vehicle request: the order activity has order.vehicle_requested with its meta', async () => {
      const t = target();
      const { owner, order, a, b } = await canvas(t);
      await post(t, owner, order.id, body([
        { orderLineId: a.lines[0]!.id, kg: 4_000 },
        { orderLineId: b.lines[0]!.id, kg: 6_000 },
      ]));
      const acts = expectOk(await call(t, 'GET', `/v1/orders/${order.id}/activity`, { token: owner }), activity);
      expect(acts[0]).toMatchObject({
        action: 'order.vehicle_requested',
        actorName: 'Rajesh Agrawal',
        meta: { contactName: 'R.K. Agarwal', channel: 'whatsapp', totalKg: 10_000, partyName: 'R.K. Agarwal' },
      });
    });

    it('vehicle request: hard delete leaves no request (the order and its history are gone)', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      expectOk(await post(t, owner, order.id, body([{ orderLineId: a.lines[0]!.id, kg: 1_000 }])), created, 201);
      const del = await call(t, 'DELETE', `/v1/orders/${order.id}`, {
        idempotencyKey: newKey(),
        token: owner,
        body: { confirmNumber: order.number },
      });
      expect(del.status).toBe(204);
      expectError(await call(t, 'GET', `/v1/orders/${order.id}`, { token: owner }), 404, 'NOT_FOUND');
      expectError(await post(t, owner, order.id, body([{ orderLineId: a.lines[0]!.id, kg: 1_000 }])), 404, 'NOT_FOUND');
    });

    it('vehicle request: needs an Idempotency-Key', async () => {
      const t = target();
      const { owner, order, a } = await canvas(t);
      expectError(
        await call(t, 'POST', `/v1/orders/${order.id}/vehicle-requests`, {
          token: owner,
          body: body([{ orderLineId: a.lines[0]!.id, kg: 1_000 }]),
        }),
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    });
  });
}
