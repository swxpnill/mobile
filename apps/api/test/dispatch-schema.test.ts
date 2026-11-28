import { SAMPLE_WORLD } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { defineRoute } from '../src/http/route.ts';
import { bearerFor, buildTestApp, closeTestApps, ownerInsertTenant, TEST_NOW, type TestApp } from './helpers.ts';
import { buildWorld } from './support/world.ts';

afterEach(closeTestApps);

const T = SAMPLE_WORLD.tenant.id;
const at = new Date(TEST_NOW).toISOString();

/** A truck of the sample tenant in the given state, with its gross and tare. */
async function truckIn(t: TestApp, state: 'weighed' | 'dispatched') {
  const r = await t.ownerDb.$client.query<{ id: string; tare_kg: string; gross_kg: string }>(
    `select id, tare_kg, gross_kg from trucks where tenant_id = $1 and state = $2 limit 1`,
    [T, state],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`no ${state} truck in the world`);
  return { id: row.id, tareKg: Number(row.tare_kg), grossKg: Number(row.gross_kg) };
}

const insertWeighment = (t: TestApp, tenantId: string, truckId: string, eventId: string | null) =>
  t.ownerDb.$client.query(
    `insert into weighments (id, tenant_id, truck_id, kind, kg, entered_by, device_id, client_event_id,
       captured_at_device, captured_at, received_at, clock_skew_flag, superseded_by, created_at, updated_at)
     values ($1, $2, $3, 'tare', 12000, $4, 'dev-1', $5, $6, $6, $6, false, null, $6, $6)`,
    [uuidv7(), tenantId, truckId, SAMPLE_WORLD.ids.users.ravi, eventId, at],
  );

describe('dispatch schema (B3 Task 2)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await buildWorld(t);
  });

  it('a weighment, tombstone or ledger row cannot point at another tenant’s truck', async () => {
    const other = await ownerInsertTenant(t.ownerDb, 'Other Group');
    const truck = await truckIn(t, 'dispatched');
    await expect(insertWeighment(t, other, truck.id, uuidv7())).rejects.toThrow(/weighments_truck_fk/);
    await expect(
      t.ownerDb.$client.query(
        `insert into truck_tombstones (tenant_id, truck_id, plant_id, reason, removed_at) values ($1, $2, $3, 'deleted', $4)`,
        [other, truck.id, SAMPLE_WORLD.ids.plants.siltara, at],
      ),
    ).rejects.toThrow(/truck_tombstones_plant_fk/);
  });

  it('one weighment per client event id in a tenant; corrections carry none', async () => {
    const truck = await truckIn(t, 'dispatched');
    const eventId = uuidv7();
    await insertWeighment(t, T, truck.id, eventId);
    await expect(insertWeighment(t, T, truck.id, eventId)).rejects.toThrow(/weighments_tenant_client_event_key/);
    await insertWeighment(t, T, truck.id, null);
    await insertWeighment(t, T, truck.id, null);
  });

  it('one remembered sync event per client event id in a tenant', async () => {
    const truck = await truckIn(t, 'dispatched');
    const id = uuidv7();
    const remember = () =>
      t.ownerDb.$client.query(
        `insert into sync_events (tenant_id, client_event_id, user_id, truck_id, status, created_at)
         values ($1, $2, $3, $4, 'accepted', $5)`,
        [T, id, SAMPLE_WORLD.ids.users.ravi, truck.id, at],
      );
    await remember();
    await expect(remember()).rejects.toThrow(/sync_events_pkey/);
  });

  it('a weighed or dispatched truck whose allocations do not sum to gross − tare cannot commit (deferred)', async () => {
    for (const state of ['weighed', 'dispatched'] as const) {
      const truck = await truckIn(t, state);
      const client = await t.ownerDb.$client.connect();
      try {
        await client.query('begin');
        // Inside the transaction the mismatch is allowed (deferred); the check runs at commit.
        await client.query(`update trucks set gross_kg = gross_kg + 1 where id = $1`, [truck.id]);
        await expect(client.query('commit')).rejects.toThrow(/truck_allocations_sum/);
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
      // Fixing the allocations in the same transaction commits.
      const ok = await t.ownerDb.$client.connect();
      try {
        await ok.query('begin');
        await ok.query(`update trucks set gross_kg = gross_kg + 1 where id = $1`, [truck.id]);
        await ok.query(
          `update truck_allocations set net_kg = net_kg + 1
            where (tenant_id, truck_id, order_line_id) = (select tenant_id, truck_id, order_line_id
                     from truck_allocations where truck_id = $1 order by position limit 1)`,
          [truck.id],
        );
        await ok.query('commit');
      } finally {
        ok.release();
      }
    }
  });

  it('the ledger keeps signed rupees and a reversal points at what it reverses', async () => {
    const truck = await truckIn(t, 'dispatched');
    const earning = uuidv7();
    const brokerId = (
      await t.ownerDb.$client.query<{ id: string }>(`select id from parties where tenant_id = $1 and type = 'broker' limit 1`, [T])
    ).rows[0]!.id;
    const insert = (id: string, kind: string, amount: number, reverses: string | null) =>
      t.ownerDb.$client.query(
        `insert into broker_ledger (id, tenant_id, broker_id, kind, truck_id, amount_rupees, breakdown, reverses_id, created_at, created_by)
         values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, $9)`,
        [id, T, brokerId, kind, truck.id, amount, reverses, at, SAMPLE_WORLD.ids.users.rajesh],
      );
    await insert(earning, 'earning', 1_234, null);
    await insert(uuidv7(), 'reversal', -1_234, earning);
    await expect(insert(uuidv7(), 'bonus', 5, null)).rejects.toThrow(/broker_ledger_kind_check/);
    await expect(insert(uuidv7(), 'reversal', -1, uuidv7())).rejects.toThrow(/broker_ledger_reverses_fk/);
  });

  it('a request whose commit breaks the allocation sum answers 422 ALLOC_MISMATCH, not a 500', async () => {
    const truck = await truckIn(t, 'weighed');
    // A second app on the same database: the world's app has started and takes no new route.
    const fresh = await buildTestApp();
    defineRoute(fresh.app, 'POST', '/v1/test/break-sum', {
      action: 'weighment.correct',
      idempotent: true,
      async handler(ctx) {
        await ctx.tx.execute(sql`update trucks set gross_kg = gross_kg + 5 where id = ${truck.id}`);
        return {};
      },
    });
    const owner = await bearerFor(fresh, T, SAMPLE_WORLD.ids.users.rajesh);
    const res = await fresh.app.inject({ method: 'POST', url: '/v1/test/break-sum', headers: { ...owner, 'idempotency-key': uuidv7() } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('ALLOC_MISMATCH');
    expect((await truckIn(t, 'weighed')).grossKg).toBe(truck.grossKg);
  });
});
