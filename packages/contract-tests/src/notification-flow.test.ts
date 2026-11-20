/**
 * Notifications, flow by flow (TON-57 check). One order goes through the whole business flow
 * against the in-process mock, with every person signed in on their own phone and registered for
 * push. After each step the test compares, person by person, which notification kinds they got as
 * a list row and which reached their phone as a push, against the table agreed with the client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type NotificationKind,
  type PushMessage,
  SAMPLE_MASTERS,
  istDateOf,
  notificationPageSchema,
  orderSchema,
  truckSchema,
} from '@tonnage/shared';
import { createFakeClock, createMockApi } from '@tonnage/mock-api';
import { COMPANY, DAY, MINUTE, PEOPLE, type ContractTarget, call, expectOk, newKey, signIn } from './harness.ts';
import { createOrder } from './suites/orders.contract.ts';
import { approveCall, phone, sync, synced } from './suites/sync.contract.ts';

type Who = keyof typeof PEOPLE;
const CAST: Who[] = ['rajesh', 'priya', 'amit', 'kiran', 'ravi', 'sanjay'];
const tick = () => new Promise((r) => setTimeout(r, 0));

/** What one person got from one step: kinds as list rows, and kinds pushed to their phone. */
type Got = { rows: NotificationKind[]; pushed: NotificationKind[] };

describe('notifications, flow by flow (every person, rows and pushes)', () => {
  const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30)); // Tue 3 Nov, 10:00 IST
  let t: ContractTarget;
  const pushes: PushMessage[] = [];
  const tokens = {} as Record<Who, string>;
  const seen = new Set<string>();

  beforeAll(async () => {
    const m = await createMockApi({ clock });
    m.controls.onPush((p) => pushes.push(p));
    t = { transport: m.transport, reset: m.controls.reset, clock, fixtures: m.fixtures, capabilities: { concurrency: false } };
    await signInAll();
  });
  afterAll(() => pushes.splice(0));

  /** Each person on their own phone, with that phone registered for push. */
  async function signInAll() {
    for (const who of CAST) {
      const deviceId = `019a4c00-00ff-7000-8000-${(CAST.indexOf(who) + 1).toString().padStart(12, '0')}`;
      tokens[who] = (await signIn(t, PEOPLE[who].mobile, deviceId)).accessToken;
      const reg = await call(t, 'POST', '/v1/notifications/push-token', { token: tokens[who], body: { deviceId, token: `push:${who}` } });
      expect(reg.status).toBe(200);
    }
  }

  /** Runs one step and returns, per person, the new rows and the alerts pushed to their phone. */
  async function step(run: () => Promise<unknown>): Promise<Record<Who, Got>> {
    pushes.splice(0);
    await run();
    await tick();
    const out = {} as Record<Who, Got>;
    for (const who of CAST) {
      const page = expectOk(await call(t, 'GET', '/v1/notifications', { token: tokens[who] }), notificationPageSchema);
      const fresh = page.items.filter((n) => !seen.has(n.id));
      fresh.forEach((n) => seen.add(n.id));
      out[who] = {
        rows: fresh.map((n) => n.kind).sort(),
        pushed: pushes
          .filter((p) => p.token === `push:${who}` && p.message.type === 'alert')
          .map((p) => (p.message.type === 'alert' ? p.message.notification.kind : ('sync' as never)))
          .sort(),
      };
    }
    return out;
  }

  /** Expected for everyone: alert = row + push; row = row only; anyone not named gets nothing. */
  function expectTold(got: Record<Who, Got>, alert: Partial<Record<Who, NotificationKind[]>>, rowOnly: Partial<Record<Who, NotificationKind[]>> = {}) {
    for (const who of CAST) {
      const a = alert[who] ?? [];
      const r = rowOnly[who] ?? [];
      expect({ who, ...got[who] }).toEqual({ who, rows: [...a, ...r].sort(), pushed: [...a].sort() });
    }
  }

  const sid = <S extends { companyId: string }>(o: { subOrders: S[] }, company: string): S => o.subOrders.find((s) => s.companyId === company)!;
  let order: ReturnType<typeof orderSchema.parse>;
  let truckId = '';
  const ravi = () => phone(truckId, () => clock.now());
  let ph: ReturnType<typeof phone>;

  it('1. Priya creates an order (AIP Siltara + KRM Borai): owner and the Siltara plant head', async () => {
    const got = await step(async () => {
      order = expectOk(await createOrder(t, tokens.priya), orderSchema, 201);
    });
    expectTold(got, { rajesh: ['order.created'], kiran: ['order.created'] });
  });

  it('2. Priya assigns a truck at Siltara: Ravi (and his tasks refresh) and Kiran', async () => {
    const a = sid(order, COMPANY.AIP);
    const got = await step(async () => {
      const truck = expectOk(
        await call(t, 'POST', `/v1/sub-orders/${a.id}/trucks`, {
          token: tokens.priya,
          idempotencyKey: newKey(),
          body: { vehicleNo: 'CG 04 MK 2291', transporterId: null, driverName: 'Ramesh', driverPhone: '98261 00099', lrNo: null, plan: [{ orderLineId: a.lines[0]!.id, plannedKg: 24_000 }] },
        }),
        truckSchema,
        201,
      );
      truckId = truck.id;
      ph = ravi();
    });
    expectTold(got, { ravi: ['truck.assigned'], kiran: ['truck.assigned'] });
    expect(pushes.some((p) => p.token === 'push:ravi' && p.message.type === 'sync')).toBe(true);
  });

  it('3. Ravi marks it arrived: Kiran is alerted; owner and city staff get a quiet row', async () => {
    const got = await step(() => synced(sync(t, tokens.ravi, [ph.atGate()], { deviceId: '019a4c00-00ff-7000-8000-000000000005' })));
    expectTold(got, { kiran: ['truck.arrived'] }, { rajesh: ['truck.arrived'], priya: ['truck.arrived'], amit: ['truck.arrived'] });
  });

  it('4. Ravi weighs the tare: nobody is told', async () => {
    const got = await step(() => synced(sync(t, tokens.ravi, [ph.tare(12_000)], { deviceId: '019a4c00-00ff-7000-8000-000000000005' })));
    expectTold(got, {});
  });

  it('5. Ravi saves the weights (2 MT over the line): the approvers, owner and city staff', async () => {
    const lineId = sid(order, COMPANY.AIP).lines[0]!.id;
    const got = await step(() =>
      synced(sync(t, tokens.ravi, [ph.gross(12_000 + 26_000, [{ orderLineId: lineId, netKg: 26_000 }])], { deviceId: '019a4c00-00ff-7000-8000-000000000005' })),
    );
    expectTold(got, { rajesh: ['truck.weighed'], priya: ['truck.weighed'], amit: ['truck.weighed'] });
  });

  it('6. Amit approves: dispatched to owner, Priya, Kiran, Ravi; over-loaded to owner and Priya (the creator)', async () => {
    const got = await step(async () => {
      const now = expectOk(await call(t, 'GET', `/v1/trucks/${truckId}`, { token: tokens.amit }), truckSchema);
      expect((await approveCall(t, tokens.amit, now)).status).toBe(200);
    });
    expectTold(got, {
      rajesh: ['order.over_tolerance', 'truck.dispatched'],
      priya: ['order.over_tolerance', 'truck.dispatched'],
      kiran: ['truck.dispatched'],
      ravi: ['truck.dispatched'],
    });
  });

  it('7. A weight from Sanjay’s phone on a truck cancelled meanwhile: the owner (Needs attention)', async () => {
    const b = sid(order, COMPANY.KRM);
    let other = '';
    const assigned = await step(async () => {
      other = expectOk(
        await call(t, 'POST', `/v1/sub-orders/${b.id}/trucks`, {
          token: tokens.priya,
          idempotencyKey: newKey(),
          body: { vehicleNo: 'CG 07 BR 8810', transporterId: null, driverName: 'Rakesh', driverPhone: '98261 00098', lrNo: null, plan: [{ orderLineId: b.lines[0]!.id, plannedKg: 10_000 }] },
        }),
        truckSchema,
        201,
      ).id;
    });
    expectTold(assigned, { sanjay: ['truck.assigned'] }); // Borai has no plant head
    const cancelled = await step(async () => {
      const v = expectOk(await call(t, 'GET', `/v1/trucks/${other}`, { token: tokens.priya }), truckSchema).version;
      expect((await call(t, 'POST', `/v1/trucks/${other}/cancel`, { token: tokens.priya, idempotencyKey: newKey(), body: { reason: 'Wrong vehicle', note: '', version: v } })).status).toBe(200);
    });
    expectTold(cancelled, {});
    const refused = await step(() => synced(sync(t, tokens.sanjay, [phone(other, () => clock.now()).tare(11_000)], { deviceId: '019a4c00-00ff-7000-8000-000000000006' })));
    expectTold(refused, { rajesh: ['rejection.created'] });
  });

  it('8. Amit records a payment to R.K. Agarwal: owner and Priya (money roles), never plant roles', async () => {
    const got = await step(async () => {
      const res = await call(t, 'POST', `/v1/brokers/${SAMPLE_MASTERS.ids.parties.rkAgarwal}/payments`, {
        token: tokens.amit,
        idempotencyKey: newKey(),
        body: { paidRupees: 1_000, tdsRupees: 0, mode: 'neft', utr: '223614', paidOn: istDateOf(clock.now()) },
      });
      expect(res.status).toBe(201);
    });
    expectTold(got, { rajesh: ['broker.payment_recorded'], priya: ['broker.payment_recorded'] });
  });

  it('9. Amit short closes the Siltara part: owner, Priya (the creator) and Kiran', async () => {
    const got = await step(async () => {
      const fresh = expectOk(await call(t, 'GET', `/v1/orders/${order.id}`, { token: tokens.amit }), orderSchema);
      const a = sid(fresh, COMPANY.AIP);
      const res = await call(t, 'POST', `/v1/sub-orders/${a.id}/short-close`, {
        token: tokens.amit,
        idempotencyKey: newKey(),
        body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: false, version: a.version },
      });
      expect(res.status).toBe(200);
    });
    expectTold(got, { rajesh: ['order.short_closed'], priya: ['order.short_closed'], kiran: ['order.short_closed'] });
  });

  it('10. Twelve days later at 09:00 IST (aged = more than 10 full days), the first request sends the digest: owner and city staff', async () => {
    // To 09:00 IST twelve days on; sessions expire meanwhile, so everyone signs in again.
    const IST = 330 * MINUTE;
    const startOfIstDay = Math.floor((clock.now() + IST) / DAY) * DAY - IST;
    clock.advance(startOfIstDay + 12 * DAY + 9 * 60 * MINUTE - clock.now());
    const got = await step(() => signInAll());
    expectTold(got, { rajesh: ['orders.aged'], priya: ['orders.aged'], amit: ['orders.aged'] });
  });
});
