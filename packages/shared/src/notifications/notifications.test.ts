import { describe, expect, it } from 'vitest';
import {
  type NotificationContent,
  type RecipientUser,
  NOTIFICATION_KINDS,
  deepLinkFor,
  isAllowedDeepLink,
  notificationSchema,
  pushMessageSchema,
  recipientsFor,
  renderNotification,
  tileFor,
} from './index.ts';

const ID = '019a4c00-0003-7000-8000-000000000001';
const ID2 = '019a4c00-0003-7000-8000-000000000002';
const AT = '2026-11-19T05:18:00.000Z'; // 10:48 IST

const users: RecipientUser[] = [
  { id: 'owner', role: 'owner', active: true, plantIds: [] },
  { id: 'priya', role: 'city_staff', active: true, plantIds: [] },
  { id: 'amit', role: 'city_staff', active: true, plantIds: [] },
  { id: 'kiran', role: 'plant_head', active: true, plantIds: ['siltara'] },
  { id: 'ravi', role: 'supervisor', active: true, plantIds: ['siltara'] },
  { id: 'sanjay', role: 'supervisor', active: true, plantIds: ['borai'] },
  { id: 'gone', role: 'owner', active: false, plantIds: [] },
];
const ids = (r: { userId: string }[]) => r.map((x) => x.userId);

describe('recipientsFor', () => {
  it('order created: owner and plant heads of the touched plants, never the actor or inactive people', () => {
    expect(ids(recipientsFor({ kind: 'order.created', actorId: 'priya', plantIds: ['siltara'] }, users))).toEqual(['owner', 'kiran']);
    expect(ids(recipientsFor({ kind: 'order.created', actorId: 'owner', plantIds: ['borai'] }, users))).toEqual([]);
  });

  it('truck assigned: plant head gets an alert, the plant’s supervisors a row plus a silent sync', () => {
    const r = recipientsFor({ kind: 'truck.assigned', actorId: 'priya', plantIds: ['siltara'] }, users);
    expect(r).toEqual([
      { userId: 'kiran', role: 'plant_head', delivery: 'alert' },
      { userId: 'ravi', role: 'supervisor', delivery: 'row-and-sync' },
    ]);
  });

  it('dispatched: owner, the city-staff creator and the plant head; other city staff are not told', () => {
    const r = recipientsFor({ kind: 'truck.dispatched', actorId: 'ravi', plantIds: ['siltara'], orderCreatorId: 'priya' }, users);
    expect(ids(r)).toEqual(['owner', 'priya', 'kiran']);
  });

  it('money and attention kinds never reach plant roles', () => {
    expect(ids(recipientsFor({ kind: 'broker.payment_recorded', actorId: 'priya', plantIds: ['siltara'] }, users))).toEqual(['owner', 'amit']);
    expect(ids(recipientsFor({ kind: 'rejection.created', actorId: 'ravi', plantIds: ['siltara'] }, users))).toEqual(['owner']);
    expect(ids(recipientsFor({ kind: 'orders.aged', actorId: 'system', plantIds: [] }, users))).toEqual(['owner', 'priya', 'amit']);
  });

  it('over tolerance and short close follow the creator rule; short close also tells the plant head', () => {
    expect(ids(recipientsFor({ kind: 'order.over_tolerance', actorId: 'ravi', plantIds: ['siltara'], orderCreatorId: 'priya' }, users))).toEqual(['owner', 'priya']);
    expect(ids(recipientsFor({ kind: 'order.short_closed', actorId: 'owner', plantIds: ['siltara'], orderCreatorId: 'owner' }, users))).toEqual(['kiran']);
  });

  it('every kind is handled', () => {
    for (const kind of NOTIFICATION_KINDS) expect(() => recipientsFor({ kind, actorId: 'x', plantIds: [] }, users)).not.toThrow();
  });
});

const dispatched: NotificationContent = {
  kind: 'truck.dispatched',
  data: { truckId: ID, orderId: ID2, vehicleNo: 'CG 04 MK 2291', netKg: 24_180, partyName: 'Shubham Traders', companyName: 'Aarav Ispat Pvt Ltd' },
};

describe('renderNotification (board 37)', () => {
  it('dispatched in MT and in kg, with the IST time', () => {
    expect(renderNotification({ ...dispatched, createdAt: AT }, 'mt')).toEqual({
      title: 'CG 04 MK 2291 dispatched',
      body: '24.180 MT to Shubham Traders · Aarav · 10:48',
    });
    expect(renderNotification({ ...dispatched, createdAt: AT }, 'kg').body).toBe('24,180 kg to Shubham Traders · Aarav · 10:48');
  });

  it('new order names the creator, party, quantity and units', () => {
    const r = renderNotification(
      { kind: 'order.created', data: { orderId: ID, orderNumber: 'SO-2611-0142', actorName: 'Priya Sharma', partyName: 'Shubham Traders', orderedKg: 84_000, companyCodes: ['AIP', 'KRM'] }, createdAt: AT },
      'mt',
    );
    expect(r).toEqual({ title: 'New order SO-2611-0142', body: 'Priya · Shubham Traders · 84.000 MT · AIP + KRM' });
  });

  it('aged orders: singular and plural', () => {
    const aged = (count: number) => renderNotification({ kind: 'orders.aged', data: { count, days: 10, pendingKg: 186_400 }, createdAt: AT }, 'mt');
    expect(aged(1).title).toBe('1 order older than 10 days');
    expect(aged(6)).toEqual({ title: '6 orders older than 10 days', body: '186.400 MT still pending · tap to review' });
  });

  it('payment: due, and an advance when the broker is overpaid', () => {
    const pay = (dueRupees: number) =>
      renderNotification({ kind: 'broker.payment_recorded', data: { brokerId: ID, brokerName: 'R.K. Agarwal', paidRupees: 40_000, dueRupees, mode: 'neft', actorName: 'Rajesh Agrawal' }, createdAt: AT }, 'mt');
    expect(pay(86_400)).toEqual({ title: '₹40,000 paid to R.K. Agarwal', body: 'NEFT · recorded by Rajesh · ₹86,400 still due' });
    expect(pay(-5_000).body).toBe('NEFT · recorded by Rajesh · Advance ₹5,000');
    expect(pay(0).body).toBe('NEFT · recorded by Rajesh · Nothing due');
  });

  it('over tolerance, short close, assigned and rejection', () => {
    const r = (c: NotificationContent) => renderNotification({ ...c, createdAt: AT }, 'mt');
    expect(r({ kind: 'order.over_tolerance', data: { orderId: ID, subOrderId: ID2, subOrderNumber: 'SO-2611-0142-A', partyName: 'Shubham Traders', overKg: 180 } })).toEqual({
      title: 'Over-loaded by 0.180 MT',
      body: 'SO-2611-0142-A · Shubham Traders · allowed',
    });
    expect(r({ kind: 'order.short_closed', data: { orderId: ID, subOrderNumber: 'SO-2610-0136-A', partyName: 'Gupta Hardware', closedKg: 11_800 } })).toEqual({
      title: 'SO-2610-0136-A short closed',
      body: '11.800 MT stopped · Gupta Hardware',
    });
    expect(r({ kind: 'truck.assigned', data: { truckId: ID, orderId: ID2, vehicleNo: 'CG 07 KL 3304', plannedKg: 10_000, partyName: 'Mittal Brokers', plantName: 'Siltara' } }).body).toBe(
      '10.000 MT planned · Mittal Brokers · Siltara',
    );
    expect(r({ kind: 'rejection.created', data: { rejectionId: ID, vehicleNo: 'CG 07 KL 3304', code: 'TRUCK_CANCELLED' } })).toEqual({
      title: 'Weight not accepted · CG 07 KL 3304',
      body: 'Truck was cancelled before this weight reached the server · Needs attention',
    });
  });

  it('every kind has a tile', () => {
    for (const kind of NOTIFICATION_KINDS) expect(tileFor(kind).icon).toBeTruthy();
    expect(tileFor('truck.dispatched')).toEqual({ icon: 'check', tone: 'gr' });
  });
});

describe('deep links', () => {
  it('per kind and role', () => {
    const assigned: NotificationContent = { kind: 'truck.assigned', data: { truckId: ID, orderId: ID2, vehicleNo: 'X', plannedKg: 1, partyName: 'P', plantName: 'S' } };
    expect(deepLinkFor(assigned, 'supervisor')).toBe('/tasks');
    expect(deepLinkFor(assigned, 'plant_head')).toBe(`/trucks/${ID}`);
    expect(deepLinkFor(dispatched, 'owner')).toBe(`/trucks/${ID}`);
    expect(deepLinkFor({ kind: 'orders.aged', data: { count: 2, days: 10, pendingKg: 1 } }, 'owner')).toBe('/orders?aged=1');
    expect(deepLinkFor({ kind: 'rejection.created', data: { rejectionId: ID, vehicleNo: 'X', code: 'TARE_CONFLICT' } }, 'owner')).toBe('/attention');
  });

  it('every link it makes is allowed, and nothing else is', () => {
    for (const ok of [`/orders/${ID}`, `/trucks/${ID}`, `/parties/${ID}`, '/orders?aged=1', '/tasks', '/attention', '/notifications']) {
      expect(isAllowedDeepLink(ok)).toBe(true);
    }
    for (const bad of ['https://evil.example', '//evil', '/users', `/orders/${ID}/../users`, '/orders/not-an-id', `/orders/${ID}?x=1`, '', 'tasks', '/orders?aged=1&x=2']) {
      expect(isAllowedDeepLink(bad)).toBe(false);
    }
  });
});

describe('schemas', () => {
  it('parses a stored notification and rejects unknown kinds or a mismatched payload', () => {
    const row = { id: ID, ...dispatched, deepLink: `/trucks/${ID}`, readAt: null, createdAt: AT };
    expect(notificationSchema.parse(row)).toEqual(row);
    expect(notificationSchema.safeParse({ ...row, kind: 'nope' }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...row, kind: 'orders.aged' }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...row, data: { ...dispatched.data, netKg: 1.5 } }).success).toBe(false);
  });

  it('push messages: alert carries a notification, sync carries nothing to show', () => {
    expect(pushMessageSchema.parse({ token: 'mock:dev-1', message: { type: 'sync', reason: 'tasks' } }).message.type).toBe('sync');
    expect(pushMessageSchema.safeParse({ token: 'mock:dev-1', message: { type: 'alert' } }).success).toBe(false);
  });
});
