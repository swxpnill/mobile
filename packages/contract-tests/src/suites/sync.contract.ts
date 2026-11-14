import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Order,
  type SyncEvent,
  type TransportResponse,
  doneTodaySchema,
  orderSchema,
  syncResponseSchema,
  tasksPageSchema,
  truckSchema,
} from '@tonnage/shared';
import {
  COMPANY,
  DEVICE_A,
  DEVICE_B,
  MINUTE,
  PEOPLE,
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
import { editBody } from './order-lifecycle.contract.ts';
import { CANVAS_ORDER, createOrder } from './orders.contract.ts';

let eventSeq = 0;
/** A fresh, well-formed event id. */
function eventId(): string {
  eventSeq += 1;
  return `019a4c00-00ee-7000-8000-${eventSeq.toString(16).padStart(12, '0')}`;
}

type Alloc = { orderLineId: string; netKg: number };

/** A phone's events for one truck; `at` is the phone's own clock. */
function phone(truckId: string, at: () => number) {
  let seq = 0;
  const base = () => ({ eventId: eventId(), truckId, deviceSeq: seq++, capturedAtDevice: new Date(at()).toISOString() });
  return {
    atGate: (): SyncEvent => ({ ...base(), type: 'AT_GATE' }),
    tare: (tareKg: number): SyncEvent => ({ ...base(), type: 'TARE', tareKg }),
    gross: (grossKg: number, allocations: Alloc[]): SyncEvent => ({ ...base(), type: 'GROSS', grossKg, allocations }),
  };
}

/** `POST /v1/weighments/sync`, optionally with the phone's clock in `X-Device-Time`. */
function sync(
  t: ContractTarget,
  token: string,
  events: SyncEvent[],
  opts: { deviceId?: string; deviceTime?: number; key?: string } = {},
): Promise<TransportResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'idempotency-key': opts.key ?? newKey(),
    'content-type': 'application/json',
  };
  if (opts.deviceTime !== undefined) headers['x-device-time'] = new Date(opts.deviceTime).toISOString();
  return t.transport.request({
    method: 'POST',
    path: '/v1/weighments/sync',
    headers,
    body: { deviceId: opts.deviceId ?? DEVICE_A, events },
  });
}

const synced = async (res: Promise<TransportResponse>) => expectOk(await res, syncResponseSchema).results;

const assignBody = (lineId: string, kg: number, vehicleNo = 'CG 04 MK 2291') => ({
  vehicleNo,
  transporterId: null,
  driverName: 'Ramesh',
  driverPhone: '98261 00099',
  lrNo: null,
  plan: [{ orderLineId: lineId, plannedKg: kg }],
});

async function assign(t: ContractTarget, token: string, subId: string, lineId: string, kg: number, vehicleNo?: string) {
  const res = await call(t, 'POST', `/v1/sub-orders/${subId}/trucks`, {
    token,
    idempotencyKey: newKey(),
    body: assignBody(lineId, kg, vehicleNo),
  });
  return expectOk(res, truckSchema, 201);
}

/** The canvas order (AIP at Siltara = A, KRM at Borai = B) and one truck on A's first line. */
async function canvasWithTruck(t: ContractTarget) {
  const owner = await tokenFor(t, PEOPLE.rajesh);
  const order = expectOk(await createOrder(t, owner), orderSchema, 201);
  const a = order.subOrders[0]!;
  const b = order.subOrders[1]!;
  const aLine = a.lines[0]!;
  const truck = await assign(t, owner, a.id, aLine.id, 24_000);
  return { owner, order, a, b, aLine, truck };
}

const getOrder = async (t: ContractTarget, token: string, id: string) =>
  expectOk(await call(t, 'GET', `/v1/orders/${id}`, { token }), orderSchema);
const getTruck = async (t: ContractTarget, token: string, id: string) =>
  expectOk(await call(t, 'GET', `/v1/trucks/${id}`, { token }), truckSchema);
const lineIn = (o: Order, lineId: string) => o.subOrders.flatMap((s) => s.lines).find((l) => l.id === lineId)!;

export function register(factory: TargetFactory): void {
  describe('contract: supervisor tasks and weighment sync', () => {
    const target = useTarget(factory);
    // Some cases move the clock; every case starts at the same instant.
    let startedAt = 0;
    beforeEach(() => {
      startedAt = target().clock.now();
    });
    afterEach(() => {
      const t = target();
      t.clock.advance(startedAt - t.clock.now());
    });

    describe('sync', () => {
      it('Ravi weighs the canvas truck: three accepted, a slip, +24,180 kg dispatched, ₹10,881 earned', async () => {
        const t = target();
        const { owner, order, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const results = await synced(
          sync(t, ravi, [p.atGate(), p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])]),
        );
        expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
        const last = results[2]!;
        expect(last.status === 'accepted' && last.task).toBeNull();
        expect(last.status === 'accepted' ? last.loadingSlipNo : undefined).toMatch(/^LS-AIP-\d{4}-\d{4}$/);
        expect(results[1]).toMatchObject({ status: 'accepted', task: { state: 'loading', tareKg: 12_460, tareDeviceId: DEVICE_A } });

        expect(lineIn(await getOrder(t, owner, order.id), aLine.id).dispatchedKg).toBe(24_180);
        const detail = await getTruck(t, owner, truck.id);
        expect(detail).toMatchObject({ state: 'dispatched', tareKg: 12_460, grossKg: 36_640, netKg: 24_180, earningRupees: 10_881 });
        expect(detail.loadingSlipNo).toBe(last.status === 'accepted' ? last.loadingSlipNo : null);
      });

      it('the same outbox pushed twice: every event duplicate; one weighment per kind, one slip, one earning', async () => {
        const t = target();
        const { owner, order, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const events = [p.atGate(), p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])];
        await synced(sync(t, ravi, events));
        const before = await getTruck(t, owner, truck.id);

        const again = await synced(sync(t, ravi, events));
        expect(again).toEqual(events.map((e) => ({ status: 'duplicate', eventId: e.eventId })));

        const after = await getTruck(t, owner, truck.id);
        expect(after.weighments.map((w) => w.kind)).toEqual(['tare', 'gross']);
        expect(after.loadingSlipNo).toBe(before.loadingSlipNo);
        expect(after.earningRupees).toBe(10_881);
        expect(after.version).toBe(before.version);
        expect(lineIn(await getOrder(t, owner, order.id), aLine.id).dispatchedKg).toBe(24_180);
      });

      it('the same Idempotency-Key replays the first answer', async () => {
        const t = target();
        const { truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const key = newKey();
        const events = [p.atGate()];
        const one = await sync(t, ravi, events, { key });
        const two = await sync(t, ravi, events, { key });
        expect(two.body).toEqual(one.body);
        expect((two.body as { results: { status: string }[] }).results[0]!.status).toBe('accepted');
      });

      it('TARE from a second phone conflicts with the winning value; the same phone corrects its tare', async () => {
        const t = target();
        const { owner, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        await synced(sync(t, ravi, [p.tare(12_460)]));

        const [conflict] = await synced(sync(t, ravi, [p.tare(12_500)], { deviceId: DEVICE_B }));
        expect(conflict).toMatchObject({ status: 'rejected', code: 'TARE_CONFLICT', server: { tareKg: 12_460, by: 'Ravi Verma' } });
        expect(conflict!.status === 'rejected' && conflict!.server?.at).toEqual(expect.any(String));

        const [fixed] = await synced(sync(t, ravi, [p.tare(12_470)]));
        expect(fixed).toMatchObject({ status: 'accepted', task: { tareKg: 12_470 } });
        const detail = await getTruck(t, owner, truck.id);
        expect(detail.tareKg).toBe(12_470);
        expect(detail.weighments.map((w) => [w.kg, w.superseded])).toEqual([
          [12_460, true],
          [12_470, false],
        ]);
      });

      it('allocation 1 kg off the net is ALLOC_MISMATCH and nothing is dispatched', async () => {
        const t = target();
        const { owner, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const results = await synced(
          sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_179 }])]),
        );
        expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
        expect(results[1]).toMatchObject({ code: 'ALLOC_MISMATCH', server: { state: 'loading' } });
        expect((await getTruck(t, owner, truck.id)).state).toBe('loading');
      });

      it('allocation to a line an edit removed is LINE_REMOVED', async () => {
        const t = target();
        const { owner, order, a, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        await synced(sync(t, ravi, [p.tare(12_460)]));

        const removedLine = a.lines[1]!;
        const fresh = await getOrder(t, owner, order.id);
        const body = editBody(fresh);
        body.subOrders[0]!.lines = body.subOrders[0]!.lines.filter((l) => l.id !== removedLine.id);
        expectOk(await call(t, 'PATCH', `/v1/orders/${order.id}`, { token: owner, body }), orderSchema);

        const [r] = await synced(
          sync(t, ravi, [
            p.gross(36_640, [
              { orderLineId: aLine.id, netKg: 20_000 },
              { orderLineId: removedLine.id, netKg: 4_180 },
            ]),
          ]),
        );
        expect(r).toMatchObject({ status: 'rejected', code: 'LINE_REMOVED' });
      });

      it('a truck cancelled before sync: TARE is TRUCK_CANCELLED and the GROSS after it is blocked', async () => {
        const t = target();
        const { owner, aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const events = [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])];
        expectOk(
          await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, {
            token: owner,
            body: { reason: 'Vehicle did not arrive', note: '', version: truck.version },
          }),
          truckSchema,
        );
        const results = await synced(sync(t, ravi, events));
        expect(results[0]).toMatchObject({ status: 'rejected', code: 'TRUCK_CANCELLED', server: { state: 'cancelled' } });
        expect(results[1]).toMatchObject({
          status: 'rejected',
          code: 'INVALID_STATE',
          message: 'Blocked by an earlier rejected weight',
        });
        // Replayed, both are duplicates (no second rejection).
        expect((await synced(sync(t, ravi, events))).map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
        const detail = await getTruck(t, owner, truck.id);
        expect(detail.state).toBe('cancelled');
        expect(detail.weighments).toEqual([]);
      });

      it('a blocked truck does not block another truck in the same batch', async () => {
        const t = target();
        const { owner, a, aLine, truck } = await canvasWithTruck(t);
        const other = await assign(t, owner, a.id, aLine.id, 1_000, 'CG 04 AA 1111');
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const q = phone(other.id, () => t.clock.now());
        const results = await synced(
          sync(t, ravi, [p.tare(12_460), q.tare(11_000), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_179 }]), p.tare(12_470), q.atGate()]),
        );
        expect(results.map((r) => (r.status === 'rejected' ? r.code : r.status))).toEqual([
          'accepted',
          'accepted',
          'ALLOC_MISMATCH',
          'INVALID_STATE',
          'accepted',
        ]);
      });

      it('X-Device-Time 10 minutes behind: capturedAt is moved to server time and flagged', async () => {
        const t = target();
        const { owner, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const behind = 10 * MINUTE;
        const p = phone(truck.id, () => t.clock.now() - behind - 2 * MINUTE);
        await synced(sync(t, ravi, [p.tare(12_460)], { deviceTime: t.clock.now() - behind }));
        const [w] = (await getTruck(t, owner, truck.id)).weighments;
        expect(w).toMatchObject({ kind: 'tare', clockSkew: true, capturedAt: new Date(t.clock.now() - 2 * MINUTE).toISOString() });
      });

      it('carries a date header; needs an Idempotency-Key; city staff and plant heads cannot weigh', async () => {
        const t = target();
        const { truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p = phone(truck.id, () => t.clock.now());
        const ok = await sync(t, ravi, [p.atGate()]);
        expect(Number.isNaN(Date.parse(ok.headers.date ?? ''))).toBe(false);
        const noKey = await call(t, 'POST', '/v1/weighments/sync', { token: ravi, body: { deviceId: DEVICE_A, events: [p.atGate()] } });
        expectError(noKey, 400, 'IDEMPOTENCY_KEY_REQUIRED');
        for (const who of [PEOPLE.priya, PEOPLE.kiran]) {
          expectError(await sync(t, await tokenFor(t, who), [p.atGate()]), 403, 'FORBIDDEN');
        }
      });
    });

    describe('scope and money', () => {
      it('Sanjay (Borai) cannot weigh or see a Siltara truck; supervisor payloads carry no money', async () => {
        const t = target();
        const { owner, b, aLine, truck } = await canvasWithTruck(t);
        const borai = await assign(t, owner, b.id, b.lines[0]!.id, 5_000, 'CG 07 BR 8810');
        const sanjay = await tokenFor(t, PEOPLE.sanjay);
        const p = phone(truck.id, () => t.clock.now());

        const [r] = await synced(sync(t, sanjay, [p.tare(12_460)], { deviceId: DEVICE_B }));
        expect(r).toMatchObject({ status: 'rejected', code: 'PLANT_SCOPE' });
        const sanjayTasks = expectOk(await call(t, 'GET', '/v1/supervisor/tasks', { token: sanjay }), tasksPageSchema);
        expect(sanjayTasks.items.map((x) => x.truckId)).toContain(borai.id);
        expect(sanjayTasks.items.map((x) => x.truckId)).not.toContain(truck.id);

        const ravi = await tokenFor(t, PEOPLE.ravi);
        const syncRes = await sync(t, ravi, [p.tare(12_460), p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }])]);
        expect(expectOk(syncRes, syncResponseSchema).results.map((x) => x.status)).toEqual(['accepted', 'accepted']);
        const tasksRes = await call(t, 'GET', '/v1/supervisor/tasks', { token: ravi });
        const tasks = expectOk(tasksRes, tasksPageSchema);
        expect(tasks.items.map((x) => x.truckId)).not.toContain(borai.id);
        const doneRes = await call(t, 'GET', '/v1/supervisor/done-today', { token: ravi });
        expect(expectOk(doneRes, doneTodaySchema).items.map((x) => x.truckId)).toEqual([truck.id]);
        for (const res of [syncRes, tasksRes, doneRes]) expect(moneyKeysIn(res.body)).toEqual([]);

        const sanjayDone = expectOk(await call(t, 'GET', '/v1/supervisor/done-today', { token: sanjay }), doneTodaySchema);
        expect(sanjayDone.items.map((x) => x.truckId)).not.toContain(truck.id);
      });

      it('plant heads and city staff have no supervisor views (403)', async () => {
        const t = target();
        for (const who of [PEOPLE.kiran, PEOPLE.priya]) {
          const token = await tokenFor(t, who);
          expectError(await call(t, 'GET', '/v1/supervisor/tasks', { token }), 403, 'FORBIDDEN');
          expectError(await call(t, 'GET', '/v1/supervisor/done-today', { token }), 403, 'FORBIDDEN');
        }
      });
    });

    describe('tasks pull', () => {
      it('task rows: open trucks of my plant with product names and kg', async () => {
        const t = target();
        const { aLine, truck } = await canvasWithTruck(t);
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const page = expectOk(await call(t, 'GET', '/v1/supervisor/tasks', { token: ravi }), tasksPageSchema);
        expect(page.removed).toEqual([]);
        expect(page.serverTime).toBe(new Date(t.clock.now()).toISOString());
        const task = page.items.find((x) => x.truckId === truck.id);
        expect(task).toMatchObject({
          vehicleNo: 'CG 04 MK 2291',
          state: 'assigned',
          companyCode: 'AIP',
          customerName: 'Shubham Traders',
          plan: [{ orderLineId: aLine.id, plannedKg: 24_000 }],
        });
        expect(task!.plan[0]!.productName).not.toBe('');
      });

      it('with a cursor: a truck cancelled since comes back in removed, not in items', async () => {
        const t = target();
        const { owner, a, aLine, truck } = await canvasWithTruck(t);
        const other = await assign(t, owner, a.id, aLine.id, 1_000, 'CG 04 AA 1111');
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const first = expectOk(await call(t, 'GET', '/v1/supervisor/tasks', { token: ravi }), tasksPageSchema);
        expect(first.items.map((x) => x.truckId)).toEqual(expect.arrayContaining([truck.id, other.id]));

        t.clock.advance(MINUTE);
        expectOk(
          await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, { token: owner, body: { reason: 'Other', note: '', version: 1 } }),
          truckSchema,
        );
        const next = expectOk(
          await call(t, 'GET', `/v1/supervisor/tasks?cursor=${encodeURIComponent(first.cursor)}`, { token: ravi }),
          tasksPageSchema,
        );
        expect(next.removed).toContain(truck.id);
        expect(next.items.map((x) => x.truckId)).not.toContain(truck.id);
        expect(next.cursor >= first.cursor).toBe(true);

        const full = expectOk(await call(t, 'GET', '/v1/supervisor/tasks', { token: ravi }), tasksPageSchema);
        expect(full.items.map((x) => x.truckId)).toContain(other.id);
        expect(full.items.map((x) => x.truckId)).not.toContain(truck.id);
        expect(full.removed).toEqual([]);
        expect((await call(t, 'GET', '/v1/supervisor/tasks?cursor=yesterday', { token: ravi })).status).toBe(422);
      });
    });

    describe('tasks pull after a hard delete', () => {
      it('trucks purged with their order come back in removed for their plant only', async () => {
        const t = target();
        const { owner, order, b, truck } = await canvasWithTruck(t);
        const borai = await assign(t, owner, b.id, b.lines[0]!.id, 5_000, 'CG 07 BR 8810');
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const sanjay = await tokenFor(t, PEOPLE.sanjay);
        const pull = async (token: string, cursor?: string) =>
          expectOk(
            await call(t, 'GET', `/v1/supervisor/tasks${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { token }),
            tasksPageSchema,
          );
        const raviFirst = await pull(ravi);
        const sanjayFirst = await pull(sanjay);
        expect(raviFirst.items.map((x) => x.truckId)).toContain(truck.id);

        t.clock.advance(MINUTE);
        const del = await call(t, 'DELETE', `/v1/orders/${order.id}`, { token: owner, body: { confirmNumber: order.number } });
        expect(del.status).toBe(204);

        const raviNext = await pull(ravi, raviFirst.cursor);
        expect(raviNext.removed).toEqual([truck.id]);
        expect(raviNext.items.map((x) => x.truckId)).not.toContain(truck.id);
        expect(raviNext.cursor > raviFirst.cursor).toBe(true);
        const sanjayNext = await pull(sanjay, sanjayFirst.cursor);
        expect(sanjayNext.removed).toEqual([borai.id]);
        expect(sanjayNext.removed).not.toContain(truck.id);
        // A full snapshot carries no tombstones.
        expect((await pull(ravi)).removed).toEqual([]);
      });
    });

    describe('tolerance close', () => {
      it('waits for the last open truck: 23.4 MT + cancel stays partly dispatched; 0.2 MT more completes it', async () => {
        const t = target();
        const owner = await tokenFor(t, PEOPLE.rajesh);
        const first = CANVAS_ORDER.subOrders[0]!;
        const body = { ...CANVAS_ORDER, subOrders: [{ companyId: COMPANY.AIP, lines: [first.lines[0]!] }] };
        const order = expectOk(await createOrder(t, owner, body), orderSchema, 201);
        const sub = order.subOrders[0]!;
        const line = sub.lines[0]!;
        expect(line.orderedKg).toBe(24_000);
        const one = await assign(t, owner, sub.id, line.id, 23_000, 'CG 04 AA 0001');
        const two = await assign(t, owner, sub.id, line.id, 1_000, 'CG 04 AA 0002');
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const p1 = phone(one.id, () => t.clock.now());
        const p2 = phone(two.id, () => t.clock.now());
        const statusOf = async () => (await getOrder(t, owner, order.id)).subOrders[0]!;

        const r = await synced(sync(t, ravi, [p2.tare(11_000), p1.tare(12_000), p1.gross(35_400, [{ orderLineId: line.id, netKg: 23_400 }])]));
        expect(r.map((x) => x.status)).toEqual(['accepted', 'accepted', 'accepted']);
        expect(await statusOf()).toMatchObject({ status: 'partly_dispatched', closeKind: null });

        const loading = await getTruck(t, owner, two.id);
        expectOk(
          await call(t, 'POST', `/v1/trucks/${two.id}/cancel`, { token: owner, body: { reason: 'Other', note: '', version: loading.version } }),
          truckSchema,
        );
        expect(await statusOf()).toMatchObject({ status: 'partly_dispatched', closeKind: null });

        const three = await assign(t, owner, sub.id, line.id, 600, 'CG 04 AA 0003');
        const p3 = phone(three.id, () => t.clock.now());
        const r3 = await synced(sync(t, ravi, [p3.tare(12_000), p3.gross(12_200, [{ orderLineId: line.id, netKg: 200 }])]));
        expect(r3.map((x) => x.status)).toEqual(['accepted', 'accepted']);
        expect(await statusOf()).toMatchObject({ status: 'completed', closeKind: 'tolerance' });
      });
    });

    describe('done today', () => {
      it('weighed at 23:50 IST, synced at 00:40 IST: counts on the day it was weighed', async () => {
        const t = target();
        const IST = 330 * MINUTE;
        // 23:40 IST on the start day.
        const day = Math.floor((t.clock.now() + IST) / (24 * 60 * MINUTE)) * 24 * 60 * MINUTE;
        const at2340 = day + 23 * 60 * MINUTE + 40 * MINUTE - IST;
        t.clock.advance(at2340 - t.clock.now());
        const { aLine, truck } = await canvasWithTruck(t);
        let phoneNow = at2340 + 5 * MINUTE;
        const p = phone(truck.id, () => phoneNow);
        const events = [p.tare(12_460)];
        phoneNow = at2340 + 10 * MINUTE; // 23:50 IST
        events.push(p.gross(36_640, [{ orderLineId: aLine.id, netKg: 24_180 }]));

        t.clock.advance(at2340 + 60 * MINUTE - t.clock.now()); // 00:40 IST next day
        const ravi = await tokenFor(t, PEOPLE.ravi);
        const results = await synced(sync(t, ravi, events, { deviceTime: t.clock.now() }));
        expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
        const nextDay = expectOk(await call(t, 'GET', '/v1/supervisor/done-today', { token: ravi }), doneTodaySchema);
        expect(nextDay.items.map((x) => x.truckId)).not.toContain(truck.id);

        t.clock.advance(at2340 + 15 * MINUTE - t.clock.now()); // back to 23:55 IST
        const sameDay = expectOk(await call(t, 'GET', '/v1/supervisor/done-today', { token: ravi }), doneTodaySchema);
        const item = sameDay.items.find((x) => x.truckId === truck.id);
        expect(item).toMatchObject({
          vehicleNo: 'CG 04 MK 2291',
          netKg: 24_180,
          dispatchedAt: new Date(at2340 + 10 * MINUTE).toISOString(),
        });
        expect(item!.loadingSlipNo).toMatch(/^LS-AIP-\d{4}-\d{4}$/);
        expect(sameDay.totalNetKg).toBe(sameDay.items.reduce((n, x) => n + x.netKg, 0));
      });
    });
  });
}
