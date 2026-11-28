import { type Rejection, type RestoreRejectionResult, type TasksPage } from '@tonnage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { buildDispatchWorld, type DispatchWorld, eventIds } from './support/dispatchWorld.ts';
import type { Res, Side } from './support/parity.ts';

afterEach(closeTestApps);

let w: DispatchWorld;
beforeEach(async () => {
  w = await buildDispatchWorld();
});

const both = (...a: Parameters<DispatchWorld['p']['both']>) => w.p.both(...a);
const list = (status: 'open' | 'all' = 'open') => both('GET', () => `/v1/weighment-rejections?status=${status}`);
const rows = (r: [Res, Res], s: Side) => (s === w.p.api ? r[1] : r[0]).body as Rejection[];

/** Truck 0 cancelled, then the phone's tare and gross arrive: TRUCK_CANCELLED, then blocked. */
async function cancelledThenWeighed(): Promise<{ tare: string; gross: string }> {
  for (const side of [w.p.mock, w.p.api]) {
    const res = await side.call('POST', `/v1/trucks/${w.truckId(side)}/cancel`, { body: { reason: 'Other', note: '', version: 1 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  w.p.clock.advance(60_000);
  const e = eventIds();
  for (const side of [w.p.mock, w.p.api]) {
    const res = await w.sync(side, w.events(side, 0, e));
    expect(res.status).toBe(200);
  }
  return e;
}

describe('needs attention equals the mock (B3 Task 8)', () => {
  it('lists refusals newest first with a count; restoring the tare reinstates the truck and its gross follows', async () => {
    const first = await both('GET', () => '/v1/supervisor/tasks', () => ({ as: 'ravi' }));
    await cancelledThenWeighed();
    const open = await list();
    w.expectSame(open);
    expect(rows(open, w.p.api).map((r) => r.code)).toEqual(['INVALID_STATE', 'TRUCK_CANCELLED']);
    w.expectSame(await both('GET', () => '/v1/weighment-rejections/count'));

    w.p.clock.advance(60_000);
    const tareRow = (s: Side) => rows(open, s).find((r) => r.code === 'TRUCK_CANCELLED')!.id;
    const restored = await both('POST', (s) => `/v1/weighment-rejections/${tareRow(s)}/restore`);
    w.expectSame(restored);
    const body = restored[1].body as RestoreRejectionResult;
    expect(body.rejection.status).toBe('restored');
    expect(body.truck.state).toBe('weighed');
    w.expectSame(await list('all'));
    w.expectSame(await both('GET', () => '/v1/weighment-rejections/count'));
    w.expectSame(await both('GET', (s) => `/v1/orders/${w.order(s).id}/activity`));

    // The sender's next pull settles both outbox rows.
    const cursor = (s: Side) => ((s === w.p.api ? first[1] : first[0]).body as TasksPage).cursor;
    const next = await both('GET', (s) => `/v1/supervisor/tasks?cursor=${encodeURIComponent(cursor(s))}`, () => ({ as: 'ravi' }));
    w.expectSame(next);
    expect((next[1].body as TasksPage).resolved).toHaveLength(2);
  });

  it('restore warns VEHICLE_BUSY when the vehicle went out on a replacement truck', async () => {
    await cancelledThenWeighed();
    for (const side of [w.p.mock, w.p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${w.aip(side).id}/trucks`, {
        body: {
          vehicleNo: 'CG04MK2291',
          transporterId: null,
          driverName: 'Mahesh',
          driverPhone: '9425210877',
          lrNo: '',
          plan: [{ orderLineId: w.aip(side).lines[0]!.id, plannedKg: 1_000 }],
        },
      });
      expect(res.status).toBe(201);
    }
    const open = await list();
    const restored = await both('POST', (s) => `/v1/weighment-rejections/${rows(open, s).find((r) => r.code === 'TRUCK_CANCELLED')!.id}/restore`);
    w.expectSame(restored);
    expect((restored[1].body as RestoreRejectionResult).warnings).toEqual(['VEHICLE_BUSY']);
  });

  it('a restore refused again is 409 with that code and nothing changes', async () => {
    await cancelledThenWeighed();
    // Short closing the sub-order locks the order: the cancelled truck cannot come back.
    for (const side of [w.p.mock, w.p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${w.aip(side).id}/short-close`, {
        body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: w.aip(side).version },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const open = await list();
    const res = await both('POST', (s) => `/v1/weighment-rejections/${rows(open, s).find((r) => r.code === 'TRUCK_CANCELLED')!.id}/restore`);
    w.expectSame(res);
    expect(res[1].status).toBe(409);
    w.expectSame(await list());
    w.expectSame(await both('GET', (s) => `/v1/trucks/${w.truckId(s)}`));
  });

  it('dismiss needs a 3-character reason; a resolved rejection cannot be resolved again; owner only', async () => {
    await cancelledThenWeighed();
    const open = await list();
    const id = (s: Side) => rows(open, s)[0]!.id;
    w.expectSame(await both('POST', (s) => `/v1/weighment-rejections/${id(s)}/dismiss`, () => ({ body: { reason: 'no' } })));
    w.expectSame(await both('POST', (s) => `/v1/weighment-rejections/${id(s)}/dismiss`, () => ({ as: 'priya', body: { reason: 'Duplicate truck' } })));
    const ok = await both('POST', (s) => `/v1/weighment-rejections/${id(s)}/dismiss`, () => ({ body: { reason: 'Duplicate truck' } }));
    w.expectSame(ok);
    expect((ok[1].body as Rejection).status).toBe('dismissed');
    w.expectSame(await both('POST', (s) => `/v1/weighment-rejections/${id(s)}/dismiss`, () => ({ body: { reason: 'Again' } })));
    w.expectSame(await both('POST', (s) => `/v1/weighment-rejections/${id(s)}/restore`));
    w.expectSame(await both('POST', () => '/v1/weighment-rejections/019a4c00-0000-7000-8000-00000000dead/restore'));
  });
});
