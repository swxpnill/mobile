import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Order,
  SAMPLE_MASTERS,
  dispatchBoardSchema,
  homeSchema,
  orderSchema,
  partySchema,
  recentVehicleSchema,
  truckSchema,
} from '@tonnage/shared';
import {
  PEOPLE,
  RANDOM_ID,
  type ContractTarget,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  moneyKeysIn,
  newKey,
  tokenFor,
  useTarget,
} from '../harness.ts';
import { CANVAS_ORDER, createOrder } from './orders.contract.ts';

const P = SAMPLE_MASTERS.ids.parties;

const planOf = (lineId: string, kg: number) => [{ orderLineId: lineId, plannedKg: kg }];
const assignBody = (lineId: string, kg: number, over: Record<string, unknown> = {}) => ({
  vehicleNo: 'CG 04 MK 2291',
  transporterId: null,
  driverName: 'Ramesh',
  driverPhone: '98261 00099',
  lrNo: null,
  plan: planOf(lineId, kg),
  ...over,
});

const assign = (t: ContractTarget, token: string, subId: string, body: object, key = newKey()) =>
  call(t, 'POST', `/v1/sub-orders/${subId}/trucks`, { token, idempotencyKey: key, body });

async function canvas(t: ContractTarget) {
  const owner = await tokenFor(t, PEOPLE.rajesh);
  const order = expectOk(await createOrder(t, owner), orderSchema, 201);
  const a = order.subOrders[0]!;
  const b = order.subOrders[1]!;
  return { owner, order, a, b, aLine: a.lines[0]!, bLine: b.lines[0]! };
}

const lineOf = async (t: ContractTarget, token: string, order: Order, lineId: string) => {
  const o = expectOk(await call(t, 'GET', `/v1/orders/${order.id}`, { token }), orderSchema);
  return o.subOrders.flatMap((s) => s.lines).find((l) => l.id === lineId)!;
};

export function register(factory: TargetFactory): void {
  describe('contract: trucks', () => {
    const target = useTarget(factory);

    describe('assign', () => {
      it('the canvas truck: 201, assigned, reserves 24,000 kg on the line', async () => {
        const t = target();
        const { owner, order, a, aLine } = await canvas(t);
        const truck = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 24_000)), truckSchema, 201);
        expect(truck).toMatchObject({
          state: 'assigned',
          vehicleNo: 'CG 04 MK 2291',
          companyCode: 'AIP',
          plantName: 'Siltara',
          driverPhone: '+919826100099',
          version: 1,
        });
        expect(truck.subOrderNumber).toMatch(/-A$/);
        expect(truck.warnings).toBeUndefined();
        expect((await lineOf(t, owner, order, aLine.id)).reservedKg).toBe(24_000);
      });

      it('a broker-only order has no customer: 409 CUSTOMER_REQUIRED', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const first = CANVAS_ORDER.subOrders[0]!;
        const body = {
          ...CANVAS_ORDER,
          type: 'broker_only',
          customerId: null,
          billToId: null,
          shipToId: null,
          pricingMethod: 'direct',
          basicRate: null,
          subOrders: [{ companyId: first.companyId, lines: [{ ...first.lines[0]!, typedRate: 46_000 }] }],
        };
        const order = expectOk(await createOrder(t, owner, body), orderSchema, 201);
        const sub = order.subOrders[0]!;
        expectError(await assign(t, owner, sub.id, assignBody(sub.lines[0]!.id, 10_000)), 409, 'CUSTOMER_REQUIRED');
      });

      it('a plan line of sub-order B on A: 409 LINE_NOT_ON_ORDER with the line id', async () => {
        const t = target();
        const { owner, a, bLine } = await canvas(t);
        const err = expectError(await assign(t, owner, a.id, assignBody(bLine.id, 5_000)), 409, 'LINE_NOT_ON_ORDER');
        expect(err.details).toEqual({ lineId: bLine.id });
      });

      it('the same vehicle twice: the second carries the VEHICLE_BUSY warning', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const first = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 10_000)), truckSchema, 201);
        expect(first.warnings).toBeUndefined();
        const second = expectOk(
          await assign(t, owner, a.id, assignBody(aLine.id, 5_000, { vehicleNo: 'cg 04  mk 2291' })),
          truckSchema,
          201,
        );
        expect(second.warnings).toEqual(['VEHICLE_BUSY']);
      });

      it('a plan above what is assignable still assigns, with OVER_ASSIGNABLE', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const truck = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 30_000)), truckSchema, 201);
        expect(truck.warnings).toEqual(['OVER_ASSIGNABLE']);
      });

      it('a double POST with one key makes one truck', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const key = newKey();
        const one = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 24_000), key), truckSchema, 201);
        const two = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 24_000), key), truckSchema, 201);
        expect(two.id).toBe(one.id);
        const board = expectOk(await call(t, 'GET', '/v1/dispatch', { token: owner }), dispatchBoardSchema);
        expect(board.items).toHaveLength(1);
      });

      it('needs an Idempotency-Key, a known sub-order and a valid body', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const noKey = await call(t, 'POST', `/v1/sub-orders/${a.id}/trucks`, { token: owner, body: assignBody(aLine.id, 1_000) });
        expectError(noKey, 400, 'IDEMPOTENCY_KEY_REQUIRED');
        expectError(await assign(t, owner, RANDOM_ID, assignBody(aLine.id, 1_000)), 404, 'NOT_FOUND');
        expect((await assign(t, owner, a.id, assignBody(aLine.id, 1_000, { driverPhone: '123' }))).status).toBe(422);
      });

      it('a short-closed sub-order refuses: 409 ORDER_LOCKED', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const closed = await call(t, 'POST', `/v1/sub-orders/${a.id}/short-close`, {
          token: owner,
          body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: false, version: a.version },
        });
        expect(closed.status).toBe(200);
        expectError(await assign(t, owner, a.id, assignBody(aLine.id, 1_000)), 409, 'ORDER_LOCKED');
      });

      it('supervisors and plant heads cannot assign (403)', async () => {
        const t = target();
        const { a, aLine } = await canvas(t);
        for (const who of [PEOPLE.ravi, PEOPLE.kiran]) {
          expectError(await assign(t, await tokenFor(t, who), a.id, assignBody(aLine.id, 1_000)), 403, 'FORBIDDEN');
        }
      });
    });

    describe('edit and cancel', () => {
      it('cancel releases the plan and keeps the truck; then edit and cancel are 409 TRUCK_LOCKED', async () => {
        const t = target();
        const { owner, order, a, aLine } = await canvas(t);
        const truck = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 24_000)), truckSchema, 201);
        const cancelled = expectOk(
          await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, {
            token: owner,
            body: { reason: 'Wrong vehicle', note: 'plate typo', version: truck.version },
          }),
          truckSchema,
        );
        expect(cancelled).toMatchObject({ state: 'cancelled', cancelReason: 'Wrong vehicle — plate typo', version: 2 });
        expect((await lineOf(t, owner, order, aLine.id)).reservedKg).toBe(0);
        expectError(
          await call(t, 'PATCH', `/v1/trucks/${truck.id}`, { token: owner, body: { driverName: 'Suresh', version: 2 } }),
          409,
          'TRUCK_LOCKED',
        );
        expectError(
          await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, { token: owner, body: { reason: 'Other', note: '', version: 2 } }),
          409,
          'TRUCK_LOCKED',
        );
      });

      it('edits driver, LR and plan; a stale version is refused', async () => {
        const t = target();
        const { owner, order, a, aLine } = await canvas(t);
        const truck = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 24_000)), truckSchema, 201);
        const edited = expectOk(
          await call(t, 'PATCH', `/v1/trucks/${truck.id}`, {
            token: owner,
            body: { driverName: 'Suresh', plan: planOf(aLine.id, 20_000), lrNo: 'LR-9', version: 1 },
          }),
          truckSchema,
        );
        expect(edited).toMatchObject({ driverName: 'Suresh', lrNo: 'LR-9', version: 2 });
        expect(edited.plan[0]!.plannedKg).toBe(20_000);
        expect((await lineOf(t, owner, order, aLine.id)).reservedKg).toBe(20_000);
        expectError(
          await call(t, 'PATCH', `/v1/trucks/${truck.id}`, { token: owner, body: { driverName: 'X', version: 1 } }),
          409,
          'STALE',
        );
      });

      it('a plan row for a line of another sub-order is refused on edit', async () => {
        const t = target();
        const { owner, a, aLine, bLine } = await canvas(t);
        const truck = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 1_000)), truckSchema, 201);
        const err = expectError(
          await call(t, 'PATCH', `/v1/trucks/${truck.id}`, { token: owner, body: { plan: planOf(bLine.id, 1_000), version: 1 } }),
          409,
          'LINE_NOT_ON_ORDER',
        );
        expect(err.details).toEqual({ lineId: bLine.id });
      });

      it('changing the vehicle to one already on the road warns VEHICLE_BUSY', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 1_000)), truckSchema, 201);
        const other = expectOk(
          await assign(t, owner, a.id, assignBody(aLine.id, 1_000, { vehicleNo: 'CG 04 AB 1111' })),
          truckSchema,
          201,
        );
        const edited = expectOk(
          await call(t, 'PATCH', `/v1/trucks/${other.id}`, { token: owner, body: { vehicleNo: 'CG 04 MK 2291', version: 1 } }),
          truckSchema,
        );
        expect(edited.warnings).toEqual(['VEHICLE_BUSY']);
      });

      it('a dispatched truck only takes an LR number and cannot be cancelled', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const { truckId } = await t.fixtures.addTruck({
          subOrderId: a.id,
          state: 'dispatched',
          vehicleNo: 'CG 04 ZZ 0001',
          tareKg: 12_000,
          plan: planOf(aLine.id, 10_000),
          allocations: [{ orderLineId: aLine.id, netKg: 10_000 }],
        });
        expectError(
          await call(t, 'PATCH', `/v1/trucks/${truckId}`, { token: owner, body: { driverName: 'Late', version: 1 } }),
          409,
          'TRUCK_LOCKED',
        );
        const ok = expectOk(
          await call(t, 'PATCH', `/v1/trucks/${truckId}`, { token: owner, body: { lrNo: 'LR-77', version: 1 } }),
          truckSchema,
        );
        expect(ok.lrNo).toBe('LR-77');
        expectError(
          await call(t, 'POST', `/v1/trucks/${truckId}/cancel`, { token: owner, body: { reason: 'Other', note: '', version: 2 } }),
          409,
          'TRUCK_LOCKED',
        );
      });
    });

    describe('dispatch board and detail', () => {
      it('lists open trucks loading first; counts, company filter, search and dispatched today', async () => {
        const t = target();
        const { owner, a, b, aLine, bLine } = await canvas(t);
        const assigned = expectOk(
          await assign(t, owner, a.id, assignBody(aLine.id, 5_000, { vehicleNo: 'CG 04 AA 1111' })),
          truckSchema,
          201,
        );
        await t.fixtures.addTruck({ subOrderId: a.id, state: 'loading', vehicleNo: 'CG 04 BB 2222', tareKg: 12_000, plan: planOf(aLine.id, 5_000) });
        await t.fixtures.addTruck({ subOrderId: b.id, state: 'at_gate', vehicleNo: 'CG 07 CC 3333', plan: planOf(bLine.id, 5_000) });
        await t.fixtures.addTruck({
          subOrderId: a.id,
          state: 'dispatched',
          vehicleNo: 'CG 04 DD 4444',
          tareKg: 12_000,
          plan: planOf(aLine.id, 5_000),
          allocations: [{ orderLineId: aLine.id, netKg: 5_000 }],
        });
        const open = expectOk(await call(t, 'GET', '/v1/dispatch', { token: owner }), dispatchBoardSchema);
        expect(open.items.map((x) => x.state)).toEqual(['loading', 'at_gate', 'assigned']);
        expect(open.counts).toEqual({ assigned: 1, at_gate: 1, loading: 1, dispatched_today: 1 });
        expect(open.items[2]!.id).toBe(assigned.id);

        const today = expectOk(await call(t, 'GET', '/v1/dispatch?state=dispatched_today', { token: owner }), dispatchBoardSchema);
        expect(today.items.map((x) => x.vehicleNo)).toEqual(['CG 04 DD 4444']);

        const krm = expectOk(await call(t, 'GET', `/v1/dispatch?companyId=${b.companyId}`, { token: owner }), dispatchBoardSchema);
        expect(krm.items.map((x) => x.vehicleNo)).toEqual(['CG 07 CC 3333']);
        expect(krm.counts).toEqual({ assigned: 0, at_gate: 1, loading: 0, dispatched_today: 0 });

        const q = expectOk(await call(t, 'GET', '/v1/dispatch?q=cg04bb', { token: owner }), dispatchBoardSchema);
        expect(q.items.map((x) => x.vehicleNo)).toEqual(['CG 04 BB 2222']);
        const byCustomer = expectOk(await call(t, 'GET', '/v1/dispatch?q=shubham&state=at_gate', { token: owner }), dispatchBoardSchema);
        expect(byCustomer.items).toHaveLength(1);
      });

      it('plant head: only own-plant trucks, a Borai truck is 404, no money keys anywhere', async () => {
        const t = target();
        const { owner, a, b, aLine, bLine } = await canvas(t);
        const siltara = expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 5_000)), truckSchema, 201);
        const { truckId: borai } = await t.fixtures.addTruck({
          subOrderId: b.id,
          state: 'assigned',
          vehicleNo: 'CG 07 BR 8810',
          plan: planOf(bLine.id, 5_000),
        });
        const kiran = await tokenFor(t, PEOPLE.kiran);

        const boardRes = await call(t, 'GET', '/v1/dispatch', { token: kiran });
        const board = expectOk(boardRes, dispatchBoardSchema);
        expect(board.items.map((x) => x.id)).toEqual([siltara.id]);
        expect(board.counts.assigned).toBe(1);
        expect(moneyKeysIn(boardRes.body)).toEqual([]);

        const detail = await call(t, 'GET', `/v1/trucks/${siltara.id}`, { token: kiran });
        expectOk(detail, truckSchema);
        expect(moneyKeysIn(detail.body)).toEqual([]);
        expectError(await call(t, 'GET', `/v1/trucks/${borai}`, { token: kiran }), 404, 'NOT_FOUND');

        const home = await call(t, 'GET', '/v1/home', { token: kiran });
        expect(expectOk(home, homeSchema).inPlant.map((x) => x.truckId)).toEqual([siltara.id]);
        expect(moneyKeysIn(home.body)).toEqual([]);
        const ownerHome = expectOk(await call(t, 'GET', '/v1/home', { token: owner }), homeSchema);
        expect(ownerHome.inPlant.map((x) => x.truckId).sort()).toEqual([siltara.id, borai].sort());
      });

      it('detail carries weighments; an unknown id is 404', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const { truckId } = await t.fixtures.addTruck({
          subOrderId: a.id,
          state: 'loading',
          vehicleNo: 'CG 04 BB 2222',
          tareKg: 12_460,
          plan: planOf(aLine.id, 5_000),
        });
        const truck = expectOk(await call(t, 'GET', `/v1/trucks/${truckId}`, { token: owner }), truckSchema);
        expect(truck.weighments).toHaveLength(1);
        expect(truck.weighments[0]).toMatchObject({ kind: 'tare', kg: 12_460 });
        expectError(await call(t, 'GET', `/v1/trucks/${RANDOM_ID}`, { token: owner }), 404, 'NOT_FOUND');
      });

      it('supervisors have no dispatch view (403)', async () => {
        const t = target();
        const { a, aLine } = await canvas(t);
        const { truckId } = await t.fixtures.addTruck({ subOrderId: a.id, state: 'assigned', vehicleNo: 'CG 04 BB 2222', plan: planOf(aLine.id, 5_000) });
        const ravi = await tokenFor(t, PEOPLE.ravi);
        expectError(await call(t, 'GET', '/v1/dispatch', { token: ravi }), 403, 'FORBIDDEN');
        expectError(await call(t, 'GET', `/v1/trucks/${truckId}`, { token: ravi }), 403, 'FORBIDDEN');
      });
    });

    describe('recent vehicles and transporter stats', () => {
      it('the 8 most recently assigned distinct vehicles, newest first', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const veh = (i: number) => `CG 04 XX 10${String(i).padStart(2, '0')}`;
        for (let i = 0; i < 10; i += 1) {
          expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 1_000, { vehicleNo: veh(i) })), truckSchema, 201);
          t.clock.advance(1_000);
        }
        expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 1_000, { vehicleNo: veh(3) })), truckSchema, 201);
        const list = expectOk(await call(t, 'GET', '/v1/trucks/recent-vehicles', { token: owner }), z.array(recentVehicleSchema));
        expect(list).toHaveLength(8);
        expect(list[0]!.vehicleNo).toBe(veh(3));
        expect(list[1]!.vehicleNo).toBe(veh(9));
        expect(new Set(list.map((x) => x.vehicleNo)).size).toBe(8);
        expectError(await call(t, 'GET', '/v1/trucks/recent-vehicles', { token: await tokenFor(t, PEOPLE.kiran) }), 403, 'FORBIDDEN');
      });

      it('a transporter detail has trip stats; other party types do not', async () => {
        const t = target();
        const { owner, a, aLine } = await canvas(t);
        const transporterId = P.shreeGanesh;
        expectOk(await assign(t, owner, a.id, assignBody(aLine.id, 1_000, { transporterId })), truckSchema, 201);
        const tp = expectOk(await call(t, 'GET', `/v1/parties/${transporterId}`, { token: owner }), partySchema);
        expect(tp.stats).toMatchObject({ tripsThisMonth: 1, vehiclesSeen: 1, recentVehicles: ['CG 04 MK 2291'] });
        const cust = expectOk(await call(t, 'GET', `/v1/parties/${P.shubham}`, { token: owner }), partySchema);
        expect(cust.stats.tripsThisMonth).toBeUndefined();
      });
    });
  });
}
