import { type TasksPage } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApps } from './helpers.ts';
import { buildDispatchWorld, type DispatchWorld, eventIds } from './support/dispatchWorld.ts';
import type { Res, Side } from './support/parity.ts';

afterEach(closeTestApps);

// B2's order-write hooks filled by B3 (Ruling 7): what the phones see after a short close or a
// hard delete, and what a hard delete leaves behind.
let w: DispatchWorld;
beforeEach(async () => {
  w = await buildDispatchWorld();
});

const pull = (cursor?: (s: Side) => string) =>
  w.p.both('GET', (s) => `/v1/supervisor/tasks${cursor ? `?cursor=${encodeURIComponent(cursor(s))}` : ''}`, () => ({ as: 'ravi' }));
const cursorOf = (r: [Res, Res]) => (s: Side) => ((s === w.p.api ? r[1] : r[0]).body as TasksPage).cursor;

describe('order writes and the phones (B3 Task 8)', () => {
  it('a short close cancelling both open trucks: both in the next pull’s removed', async () => {
    const first = await pull();
    w.p.clock.advance(60_000);
    for (const side of [w.p.mock, w.p.api]) {
      const res = await side.call('POST', `/v1/sub-orders/${w.aip(side).id}/short-close`, {
        body: { reason: 'Customer stopped lifting', note: '', cancelOpenTrucks: true, version: w.aip(side).version },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const next = await pull(cursorOf(first));
    w.expectSame(next);
    expect([...(next[1].body as TasksPage).removed].sort()).toEqual([w.truckId(w.p.api, 0), w.truckId(w.p.api, 1)].sort());
  });

  it('a hard delete after dispatch: deleted tombstones, zero dispatch rows for its trucks, a payment untouched', async () => {
    // Truck 0 dispatched (earning), truck 1's tare refused before arrival (a rejection).
    for (const side of [w.p.mock, w.p.api]) {
      expect((await w.sync(side, w.events(side, 0, eventIds()))).status).toBe(200);
      const tare = { eventId: uuidv7(), truckId: w.truckId(side, 1), deviceSeq: 4, capturedAtDevice: new Date(w.p.clock.now()).toISOString(), type: 'TARE', tareKg: 11_000 };
      expect((await w.sync(side, [tare])).status).toBe(200);
      expect((await side.call('POST', `/v1/trucks/${w.truckId(side, 0)}/approve`, { body: { version: 4 } })).status).toBe(200);
    }
    const db = w.p.t.ownerDb.$client;
    const brokerId = w.m(w.p.api).broker.id;
    const [{ tenant_id: tenantId, created_by: createdBy }] = (
      await db.query('select tenant_id, created_by from broker_ledger where truck_id = $1', [w.truckId(w.p.api, 0)])
    ).rows;
    await db.query(
      `insert into broker_ledger (id, tenant_id, broker_id, kind, truck_id, amount_rupees, breakdown, created_at, created_by, mode, utr, tds_rupees, paid_rupees, paid_on, note)
       values ($1, $2, $3, 'payment', null, -1000, '[]', now(), $4, 'cash', null, 0, 1000, '2026-11-01', null)`,
      [uuidv7(), tenantId, brokerId, createdBy],
    );
    const first = await pull();
    w.p.clock.advance(60_000);
    const del = await w.p.both('DELETE', (s) => `/v1/orders/${w.order(s).id}`, (s) => ({ body: { confirmNumber: w.order(s).number } }));
    w.expectSame(del);
    expect(del[1].status).toBe(204);

    const truckIds = [w.truckId(w.p.api, 0), w.truckId(w.p.api, 1)];
    for (const table of ['trucks', 'weighments', 'weighment_rejections', 'sync_events', 'truck_allocations', 'truck_plan_lines']) {
      const col = table === 'trucks' ? 'id' : 'truck_id';
      const n = (await db.query(`select count(*)::int as n from ${table} where ${col} = any($1)`, [truckIds])).rows[0].n;
      expect(n, table).toBe(0);
    }
    const ledger = (await db.query('select kind, truck_id from broker_ledger where broker_id = $1', [brokerId])).rows;
    expect(ledger).toEqual([{ kind: 'payment', truck_id: null }]);
    const graves = (await db.query('select truck_id, reason from truck_tombstones order by truck_id')).rows;
    expect(graves).toEqual([...truckIds].sort().map((id) => ({ truck_id: id, reason: 'deleted' })));

    const next = await pull(cursorOf(first));
    w.expectSame(next);
    expect([...(next[1].body as TasksPage).deleted].sort()).toEqual([...truckIds].sort());
    expect([...(next[1].body as TasksPage).removed].sort()).toEqual([...truckIds].sort());
  });
});
