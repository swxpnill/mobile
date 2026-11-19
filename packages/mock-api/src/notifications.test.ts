// F5: notifications are written inside the request's transaction and pushed only after it commits.
import { describe, expect, it } from 'vitest';
import { type PushMessage, SAMPLE_WORLD } from '@tonnage/shared';
import { createFakeClock } from './clock.ts';
import { ApiError } from './errors.ts';
import { notificationRoutes } from './handlers/notifications.ts';
import { createPushBus, notifyPayment } from './notifications.ts';
import { createPipeline } from './pipeline.ts';
import { buildRouter, route } from './router.ts';
import { issueTokens } from './sessions.ts';
import { createMemoryStorage, createStore } from './store.ts';
import { authed } from './views.ts';

const U = SAMPLE_WORLD.ids.users;
const BROKER = '019a4c00-0005-7000-8000-000000000001';
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  const store = await createStore({ storage: createMemoryStorage(), storageKey: 'k', clock });
  const pay = (fail: boolean) =>
    route('POST', fail ? '/v1/test/pay-then-fail' : '/v1/test/pay', {
      action: 'broker.pay',
      transactional: true,
      async handler(ctx) {
        notifyPayment(ctx.state, authed(ctx), ctx.now, { brokerId: BROKER, brokerName: 'R.K. Agarwal', paidRupees: 10_000, dueRupees: 5_000, mode: 'neft' });
        if (fail) throw new ApiError(409, 'STALE');
        return { status: 201, body: { ok: true } };
      },
    });
  const push = createPushBus();
  const got: PushMessage[] = [];
  push.subscribe((m) => got.push(m));
  const { handle } = createPipeline({ router: buildRouter([...notificationRoutes, pay(false), pay(true)]), store, clock, push });
  const call = (userId: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
    handle({ method, path, body, headers: { authorization: `Bearer ${issueTokens(store.state, userId, 'd', clock.now()).accessToken}` } });
  return { store, got, call };
}

describe('notification outbox (§5.7)', () => {
  it('a write that rolls back leaves no notification and pushes nothing (Review Focus 1)', async () => {
    const { store, got, call } = await setup();
    await call(U.rajesh, 'POST', '/v1/notifications/push-token', { deviceId: 'phone-of-rajesh', token: 'mock:phone-of-rajesh' });
    const res = await call(U.priya, 'POST', '/v1/test/pay-then-fail');
    expect(res.status).toBe(409);
    await tick();
    expect(store.state.notifications).toEqual([]);
    expect(store.state.pushOutbox).toEqual([]);
    expect(got).toEqual([]);
  });

  it('a committed write pushes after the response, once per device, and empties the outbox', async () => {
    const { store, got, call } = await setup();
    await call(U.rajesh, 'POST', '/v1/notifications/push-token', { deviceId: 'phone-of-rajesh', token: 'mock:phone-of-rajesh' });
    const res = await call(U.priya, 'POST', '/v1/test/pay');
    expect(res.status).toBe(201);
    expect(got).toEqual([]); // not before the caller has its answer
    await tick();
    expect(got).toHaveLength(1); // Amit (city staff) has a row but no device
    expect(got[0]!.token).toBe('mock:phone-of-rajesh');
    expect(got[0]!.message).toMatchObject({ type: 'alert', notification: { kind: 'broker.payment_recorded', data: { paidRupees: 10_000 } } });
    expect(store.state.notifications.map((n) => n.userId).sort()).toEqual([U.amit, U.rajesh].sort());
    expect(store.state.pushOutbox).toEqual([]);
  });

  it('one token per phone: a person switch moves it, and the old person’s pushes stop', async () => {
    const { got, call } = await setup();
    await call(U.rajesh, 'POST', '/v1/notifications/push-token', { deviceId: 'shared-phone', token: 'mock:shared-phone' });
    await call(U.amit, 'POST', '/v1/notifications/push-token', { deviceId: 'shared-phone', token: 'mock:shared-phone' });
    await call(U.priya, 'POST', '/v1/test/pay');
    await tick();
    // Rajesh and Amit both get a row; only Amit now holds the phone.
    expect(got).toHaveLength(1);
    expect(got[0]!.message.type === 'alert' && got[0]!.message.notification.kind).toBe('broker.payment_recorded');
    await call(U.amit, 'DELETE', '/v1/notifications/push-token/shared-phone');
    await call(U.priya, 'POST', '/v1/test/pay');
    await tick();
    expect(got).toHaveLength(1);
  });
});

describe('demo seed', () => {
  it('Rajesh has a lived-in list: valid rows, recent ones unread, never his own actions', async () => {
    const { createMockApi } = await import('./index.ts');
    const { notificationPageSchema } = await import('@tonnage/shared');
    const mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 19, 6, 0)), seedOrders: true });
    const { accessToken } = await mock.controls.signInAs(U.rajesh, 'seed-phone');
    const res = await mock.transport.request({ method: 'GET', path: '/v1/notifications', headers: { authorization: `Bearer ${accessToken}` } });
    const page = notificationPageSchema.parse(res.body);
    expect(page.items.length).toBeGreaterThan(3);
    expect(page.items.some((n) => n.readAt === null)).toBe(true);
    expect(page.items.some((n) => n.readAt !== null)).toBe(true);
    expect(page.items.some((n) => n.kind === 'truck.dispatched')).toBe(true);
    expect(page.items.filter((n) => n.kind === 'broker.payment_recorded')).toEqual([]); // he recorded it
  });
});
