import { describe, expect, it } from 'vitest';
import {
  type Notification,
  SAMPLE_MASTERS,
  istDateOf,
  notificationPageSchema,
  orderSchema,
  unreadCountSchema,
} from '@tonnage/shared';
import {
  DAY,
  DEVICE_A,
  MINUTE,
  PEOPLE,
  SECOND,
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
import { canvasWithTruck, phone, sync, synced, arrive } from './sync.contract.ts';

const BROKER = SAMPLE_MASTERS.ids.parties.rkAgarwal;
const KRM_ONLY = { ...CANVAS_ORDER, subOrders: [CANVAS_ORDER.subOrders[1]] };

const page = async (t: ContractTarget, token: string, cursor?: string) =>
  expectOk(await call(t, 'GET', `/v1/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { token }), notificationPageSchema);
const all = async (t: ContractTarget, token: string): Promise<Notification[]> => (await page(t, token)).items;
const unread = async (t: ContractTarget, token: string) =>
  expectOk(await call(t, 'GET', '/v1/notifications/unread-count', { token }), unreadCountSchema).count;
const of = <K extends Notification['kind']>(list: Notification[], kind: K) =>
  list.filter((n): n is Extract<Notification, { kind: K }> => n.kind === kind);
const kgOf = (subs: readonly { lines: readonly { orderedKg: number }[] }[]) =>
  subs.reduce((s, x) => s + x.lines.reduce((a, l) => a + l.orderedKg, 0), 0);

/** Move the clock to `hh:mm` IST, `days` IST days from now. */
function toIst(t: ContractTarget, days: number, hh: number, mm: number): void {
  const IST = 330 * MINUTE;
  const now = t.clock.now();
  const startOfIstDay = Math.floor((now + IST) / DAY) * DAY - IST;
  const target = startOfIstDay + days * DAY + (hh * 60 + mm) * MINUTE;
  if (target <= now) throw new Error('toIst: target is in the past');
  t.clock.advance(target - now);
}

export function register(factory: TargetFactory): void {
  describe('notifications', () => {
    const target = useTarget(factory);

    it('a new order tells the owner and the plant heads in scope, with their part only; never the creator', async () => {
      const t = target();
      const priya = await tokenFor(t, PEOPLE.priya);
      const order = expectOk(await createOrder(t, priya), orderSchema, 201);
      const [owner, kiran, ravi] = await Promise.all([tokenFor(t, PEOPLE.rajesh), tokenFor(t, PEOPLE.kiran), tokenFor(t, PEOPLE.ravi)]);

      const mine = of(await all(t, owner), 'order.created');
      expect(mine).toHaveLength(1);
      expect(mine[0]!.data).toMatchObject({ orderId: order.id, orderNumber: order.number, orderedKg: kgOf(order.subOrders), companyCodes: ['AIP', 'KRM'] });
      expect(mine[0]!.deepLink).toBe(`/orders/${order.id}`);
      expect(mine[0]!.readAt).toBeNull();

      const kirans = of(await all(t, kiran), 'order.created');
      expect(kirans).toHaveLength(1);
      expect(kirans[0]!.data).toMatchObject({ orderedKg: kgOf([order.subOrders[0]!]), companyCodes: ['AIP'] });

      expect(await all(t, priya)).toEqual([]);
      expect(await all(t, ravi)).toEqual([]);
    });

    it('an order only at Borai tells no one at Siltara', async () => {
      const t = target();
      expectOk(await createOrder(t, await tokenFor(t, PEOPLE.priya), KRM_ONLY), orderSchema, 201);
      expect(await all(t, await tokenFor(t, PEOPLE.kiran))).toEqual([]);
    });

    it('a payment reaches money roles only', async () => {
      const t = target();
      const priya = await tokenFor(t, PEOPLE.priya);
      const res = await call(t, 'POST', `/v1/brokers/${BROKER}/payments`, {
        token: priya,
        idempotencyKey: newKey(),
        body: { paidRupees: 10_000, tdsRupees: 0, mode: 'neft', utr: '223614', paidOn: istDateOf(t.clock.now()) },
      });
      expect(res.status).toBe(201);
      const pays = of(await all(t, await tokenFor(t, PEOPLE.rajesh)), 'broker.payment_recorded');
      expect(pays).toHaveLength(1);
      expect(pays[0]!.data).toMatchObject({ brokerId: BROKER, paidRupees: 10_000, mode: 'neft' });
      expect(pays[0]!.deepLink).toBe(`/parties/${BROKER}`);
      expect(of(await all(t, await tokenFor(t, PEOPLE.amit)), 'broker.payment_recorded')).toHaveLength(1);
      for (const p of [PEOPLE.kiran, PEOPLE.ravi]) expect(await all(t, await tokenFor(t, p))).toEqual([]);
    });

    it('assign tells the supervisor (to Tasks, no money) and the plant head (to the truck)', async () => {
      const t = target();
      const { truck } = await canvasWithTruck(t);
      const ravis = of(await all(t, await tokenFor(t, PEOPLE.ravi)), 'truck.assigned');
      expect(ravis).toHaveLength(1);
      expect(ravis[0]!.deepLink).toBe('/tasks');
      expect(ravis[0]!.data).toMatchObject({ truckId: truck.id, vehicleNo: truck.vehicleNo, plannedKg: 24_000, plantName: 'Siltara' });
      expect(JSON.stringify(ravis[0]!.data)).not.toMatch(/Rupees/);
      const kirans = of(await all(t, await tokenFor(t, PEOPLE.kiran)), 'truck.assigned');
      expect(kirans[0]!.deepLink).toBe(`/trucks/${truck.id}`);
      expect(await all(t, await tokenFor(t, PEOPLE.sanjay))).toEqual([]);
    });

    it('dispatch over tolerance tells the owner twice: dispatched and over-loaded', async () => {
      const t = target();
      const { owner, a, aLine, truck } = await canvasWithTruck(t);
      const ravi = await tokenFor(t, PEOPLE.ravi);
      const ph = phone(truck.id, () => t.clock.now());
      const net = aLine.orderedKg + 2_000;
      await arrive(t, truck.id);
      const results = await synced(sync(t, ravi, [ph.atGate(), ph.tare(12_000), ph.gross(12_000 + net, [{ orderLineId: aLine.id, netKg: net }])]));
      expect(results.every((r) => r.status === 'accepted')).toBe(true);

      const list = await all(t, owner);
      const sent = of(list, 'truck.dispatched');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.data).toMatchObject({ truckId: truck.id, netKg: net, companyName: expect.any(String) });
      const over = of(list, 'order.over_tolerance');
      expect(over).toHaveLength(1);
      expect(over[0]!.data).toMatchObject({ subOrderId: a.id, overKg: expect.any(Number) });
      expect(over[0]!.data.overKg).toBeGreaterThan(0);
    });

    it('a refused weight tells the owner, linking to Needs attention', async () => {
      const t = target();
      const { owner, truck } = await canvasWithTruck(t);
      await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, {
        token: owner,
        idempotencyKey: newKey(),
        body: { reason: 'Vehicle did not arrive', note: '', version: truck.version },
      });
      const ph = phone(truck.id, () => t.clock.now());
      await arrive(t, truck.id);
      const [r] = await synced(sync(t, await tokenFor(t, PEOPLE.ravi), [ph.tare(12_000)], { deviceId: DEVICE_A }));
      expect(r!.status).toBe('rejected');
      const rej = of(await all(t, owner), 'rejection.created');
      expect(rej).toHaveLength(1);
      expect(rej[0]!.data).toMatchObject({ vehicleNo: truck.vehicleNo, code: 'TRUCK_CANCELLED' });
      expect(rej[0]!.deepLink).toBe('/attention');
    });

    it('read one, read again, read all; another person’s id is 404', async () => {
      const t = target();
      const priya = await tokenFor(t, PEOPLE.priya);
      await createOrder(t, priya);
      await createOrder(t, priya);
      const owner = await tokenFor(t, PEOPLE.rajesh);
      expect(await unread(t, owner)).toBe(2);
      const [first] = await all(t, owner);
      expect((await call(t, 'POST', `/v1/notifications/${first!.id}/read`, { token: owner })).status).toBe(200);
      expect((await call(t, 'POST', `/v1/notifications/${first!.id}/read`, { token: owner })).status).toBe(200);
      expect(await unread(t, owner)).toBe(1);
      expect((await all(t, owner)).find((n) => n.id === first!.id)!.readAt).not.toBeNull();

      const kiran = await tokenFor(t, PEOPLE.kiran);
      expectError(await call(t, 'POST', `/v1/notifications/${first!.id}/read`, { token: kiran }), 404, 'NOT_FOUND');
      expectError(await call(t, 'POST', `/v1/notifications/${RANDOM_ID}/read`, { token: owner }), 404, 'NOT_FOUND');

      expect((await call(t, 'POST', '/v1/notifications/read-all', { token: owner })).status).toBe(200);
      expect(await unread(t, owner)).toBe(0);
    });

    it('pages of 30, newest first; rows older than 30 days are gone', async () => {
      const t = target();
      const priya = await tokenFor(t, PEOPLE.priya);
      for (let i = 0; i < 31; i++) {
        expectOk(await createOrder(t, priya, KRM_ONLY), orderSchema, 201);
        t.clock.advance(SECOND);
      }
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const p1 = await page(t, owner);
      expect(p1.items).toHaveLength(30);
      expect(p1.nextCursor).not.toBeNull();
      const times = p1.items.map((n) => Date.parse(n.createdAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      const p2 = await page(t, owner, p1.nextCursor!);
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
      expect(new Set([...p1.items, ...p2.items].map((n) => n.id)).size).toBe(31);

      t.clock.advance(31 * DAY);
      const fresh = await tokenFor(t, PEOPLE.rajesh);
      // The 31 orders are aged by now, so today's digest may be there; the old rows are not.
      expect(of(await all(t, fresh), 'order.created')).toEqual([]);
    });

    it('hard delete removes the order’s notifications from every list', async () => {
      const t = target();
      const priya = await tokenFor(t, PEOPLE.priya);
      const order = expectOk(await createOrder(t, priya), orderSchema, 201);
      const owner = await tokenFor(t, PEOPLE.rajesh);
      expect(await all(t, owner)).toHaveLength(1);
      const del = await call(t, 'DELETE', `/v1/orders/${order.id}`, { token: owner, idempotencyKey: newKey(), body: { confirmNumber: order.number } });
      expect(del.status).toBe(204);
      expect(await all(t, owner)).toEqual([]);
      expect(await all(t, await tokenFor(t, PEOPLE.kiran))).toEqual([]);
    });

    it('aged orders: one digest per IST day from 09:00, for owner and city staff only', async () => {
      const t = target();
      const owner = await tokenFor(t, PEOPLE.rajesh);
      expectOk(await createOrder(t, owner), orderSchema, 201);
      toIst(t, 12, 8, 59);
      const at0859 = await tokenFor(t, PEOPLE.rajesh);
      expect(of(await all(t, at0859), 'orders.aged')).toEqual([]);

      t.clock.advance(MINUTE);
      const o = await tokenFor(t, PEOPLE.rajesh);
      const aged = of(await all(t, o), 'orders.aged');
      expect(aged).toHaveLength(1);
      expect(aged[0]!.data).toMatchObject({ count: 1, days: 10 });
      expect(aged[0]!.deepLink).toBe('/orders?aged=1');
      expect(of(await all(t, await tokenFor(t, PEOPLE.priya)), 'orders.aged')).toHaveLength(1);
      expect(of(await all(t, await tokenFor(t, PEOPLE.kiran)), 'orders.aged')).toEqual([]);

      t.clock.advance(3 * 60 * MINUTE);
      expect(of(await all(t, await tokenFor(t, PEOPLE.rajesh)), 'orders.aged')).toHaveLength(1);
    });

    it('push tokens: register and remove are per device and validated', async () => {
      const t = target();
      const ravi = await tokenFor(t, PEOPLE.ravi);
      const reg = (body: unknown) => call(t, 'POST', '/v1/notifications/push-token', { token: ravi, body });
      expect((await reg({ deviceId: DEVICE_A, token: `mock:${DEVICE_A}` })).status).toBe(200);
      expect((await reg({ deviceId: DEVICE_A, token: `mock:${DEVICE_A}` })).status).toBe(200);
      expectError(await reg({ deviceId: 'x', token: '' }), 422, 'VALIDATION');
      expect((await call(t, 'DELETE', `/v1/notifications/push-token/${DEVICE_A}`, { token: ravi })).status).toBe(200);
      expect((await call(t, 'DELETE', `/v1/notifications/push-token/${DEVICE_A}`, { token: ravi })).status).toBe(200);
      expectError(await call(t, 'GET', '/v1/notifications'), 401, 'UNAUTHENTICATED');
    });
  });
}
