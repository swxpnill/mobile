import { describe, expect, it } from 'vitest';
import {
  SAMPLE_MASTERS,
  SAMPLE_WORLD,
  type SyncEvent,
  brokerWise,
  istDateOf,
  ledgerEntrySchema,
  plantScope,
  unpaidKg,
} from '@tonnage/shared';
import { DAY, createFakeClock, toIso } from './clock.ts';
import { applyEvent, rewriteEarning } from './dispatch.ts';
import { brokerFactRows, brokerSummary, ledgerRows, toLedgerEntry } from './ledger-views.ts';
import { seedDemoOrders } from './seed-orders.ts';
import { type BrokerLedgerRec, type MockState, seedState } from './store.ts';
import { type Authed, newId } from './views.ts';

const NOW = Date.UTC(2026, 10, 3, 4, 30); // 3 Nov 2026, 10:00 IST
const U = SAMPLE_WORLD.ids.users;
const P = SAMPLE_MASTERS.ids.parties;

function world(): MockState {
  const clock = createFakeClock(NOW);
  const s = seedState(clock);
  seedDemoOrders(s, clock);
  return s;
}

function authedAs(s: MockState, userId: string): Authed {
  const user = s.users.find((u) => u.id === userId)!;
  return { user, scope: plantScope(user), tenant: s.tenants.find((t) => t.id === user.tenantId)! };
}

const mk = (s: MockState) => s.trucks.find((t) => t.vehicleNo === 'CG 04 MK 2291')!;
const brokerOf = (s: MockState) => s.orders.find((o) => o.id === mk(s).orderId)!.brokerId!;

/** Dispatches the canvas loading truck: captured at `capturedAt`, received at `receivedMs`. */
function dispatchMk(s: MockState, capturedAt: string, receivedMs: number, netKg = 24_180) {
  const truck = mk(s);
  const event: SyncEvent = {
    eventId: newId(),
    truckId: truck.id,
    deviceSeq: 2,
    capturedAtDevice: capturedAt,
    type: 'GROSS',
    grossKg: truck.tareKg! + netKg,
    allocations: [{ orderLineId: truck.plan[0]!.orderLineId, netKg }],
  };
  const r = applyEvent(s, { user: authedAs(s, U.ravi), deviceId: truck.tareDeviceId!, now: receivedMs, offsetMs: 0 }, event);
  expect(r.status).toBe('accepted');
  return truck;
}

const payment = (s: MockState, brokerId: string, paidRupees: number, tdsRupees = 0, paidOn = '2026-11-02'): BrokerLedgerRec => {
  const rec: BrokerLedgerRec = {
    id: newId(),
    tenantId: s.tenants[0]!.id,
    brokerId,
    kind: 'payment',
    truckId: null,
    amountRupees: -(paidRupees + tdsRupees),
    breakdown: [],
    reversesId: null,
    createdAt: toIso(NOW),
    createdBy: U.rajesh,
    mode: 'neft',
    utr: 'UTR100200',
    tdsRupees,
    paidRupees,
    paidOn,
    note: null,
  };
  s.brokerLedger.push(rec);
  return rec;
};

describe('entry date', () => {
  it('an earning counts on the IST day of the truck dispatch, not of the sync', () => {
    const s = world();
    // 23:50 IST on 31 Oct, received at 00:15 IST on 1 Nov.
    const truck = dispatchMk(s, '2026-10-31T18:20:00.000Z', Date.UTC(2026, 9, 31, 18, 45));
    const rec = s.brokerLedger.find((r) => r.truckId === truck.id)!;
    expect(istDateOf(rec.createdAt)).toBe('2026-11-01');
    const row = ledgerRows(s, rec.brokerId).find((r) => r.id === rec.id)!;
    expect(row.entryDate).toBe('2026-10-31');
    expect(toLedgerEntry(s, rec).entryDate).toBe('2026-10-31');
  });

  it('a reversal keeps its own date; the replacement earning keeps the truck date', () => {
    const s = world();
    const truck = dispatchMk(s, '2026-10-31T18:20:00.000Z', Date.UTC(2026, 9, 31, 18, 45));
    truck.allocations = [{ orderLineId: truck.plan[0]!.orderLineId, netKg: 24_000 }];
    rewriteEarning(s, truck, toIso(NOW), U.rajesh);
    const rows = s.brokerLedger.filter((r) => r.truckId === truck.id);
    const byId = new Map(ledgerRows(s, brokerOf(s)).map((r) => [r.id, r]));
    expect(rows.map((r) => [r.kind, byId.get(r.id)!.entryDate])).toEqual([
      ['earning', '2026-10-31'],
      ['reversal', '2026-11-03'],
      ['earning', '2026-10-31'],
    ]);
    // Reports depend on a reversal's earning lines carrying negated kg.
    expect(byId.get(rows[1]!.id)!.netKg).toBe(-24_180);
  });

  it('a payment counts on its paidOn date', () => {
    const s = world();
    const p = payment(s, brokerOf(s), 1_000, 0, '2026-10-20');
    expect(ledgerRows(s, p.brokerId).find((r) => r.id === p.id)).toMatchObject({
      entryDate: '2026-10-20',
      amountRupees: -1_000,
      netKg: 0,
    });
  });
});

describe('FIFO oldest is the entry date', () => {
  it('a corrected truck replacement keeps its truck place, so the unpaid kg follows the oldest truck', () => {
    const s = world();
    s.brokerLedger = s.brokerLedger.filter((r) => r.kind !== 'payment'); // no seeded payment
    const truck = dispatchMk(s, '2026-09-30T18:20:00.000Z', Date.UTC(2026, 9, 1, 0, 30));
    const brokerId = brokerOf(s);
    truck.allocations = [{ orderLineId: truck.plan[0]!.orderLineId, netKg: 24_000 }];
    rewriteEarning(s, truck, toIso(NOW), U.rajesh);
    const replacement = s.brokerLedger.filter((r) => r.truckId === truck.id && r.kind === 'earning')[1]!;
    expect(replacement.amountRupees).toBe(10_800);
    payment(s, brokerId, 10_800);

    const rows = ledgerRows(s, brokerId);
    const reversedIds = new Set(rows.map((r) => r.reversesId));
    const others = rows.filter((r) => r.kind === 'earning' && r.id !== replacement.id && !reversedIds.has(r.id));
    const othersKg = others.reduce((n, r) => n + r.netKg, 0);
    expect(othersKg).toBeGreaterThan(0);
    // The payment settles the oldest live earning (the replacement, 1 Oct, older than every seeded truck); every other kg stays unpaid.
    expect(unpaidKg(rows)).toBe(othersKg);
  });
});

describe('views', () => {
  it('toLedgerEntry builds schema-valid earning, reversal and payment entries', () => {
    const s = world();
    const truck = dispatchMk(s, toIso(NOW - 60_000), NOW);
    truck.allocations = [{ orderLineId: truck.plan[0]!.orderLineId, netKg: 24_000 }];
    rewriteEarning(s, truck, toIso(NOW), U.rajesh);
    const p = payment(s, brokerOf(s), 5_000, 100);
    const [earning, reversal] = s.brokerLedger.filter((r) => r.truckId === truck.id);
    const e = ledgerEntrySchema.parse(toLedgerEntry(s, earning!));
    expect(e).toMatchObject({
      kind: 'earning',
      amountRupees: 10_881,
      payment: null,
      reversedById: reversal!.id,
      createdBy: { id: U.ravi },
      truck: { truckId: truck.id, vehicleNo: 'CG 04 MK 2291', netKg: 24_180 },
    });
    expect(e.earningLines).toEqual([expect.objectContaining({ netKg: 24_180, commissionPerMt: 150, overpricePerMt: 300 })]);
    expect(e.truck!.subOrderNumber).toMatch(/^SO-/);
    const r = ledgerEntrySchema.parse(toLedgerEntry(s, reversal!));
    expect(r).toMatchObject({ kind: 'reversal', amountRupees: -10_881, reversesId: earning!.id, reversedById: null });
    expect(r.earningLines[0]!.netKg).toBe(-24_180);
    const pay = ledgerEntrySchema.parse(toLedgerEntry(s, p));
    expect(pay).toMatchObject({
      kind: 'payment',
      amountRupees: -5_100,
      truck: null,
      earningLines: [],
      payment: { mode: 'neft', utr: 'UTR100200', paidRupees: 5_000, tdsRupees: 100, paidOn: '2026-11-02' },
    });
  });

  it('brokerSummary: due, unpaid kg and this month totals', () => {
    const s = world();
    const brokerId = P.mittal;
    const before = brokerSummary(s, brokerId, '2026-11-03');
    expect(before.month).toBe('2026-11');
    payment(s, brokerId, 1_000);
    const after = brokerSummary(s, brokerId, '2026-11-03');
    expect(after.dueRupees).toBe(before.dueRupees - 1_000);
    expect(after.paidThisMonthRupees).toBe(before.paidThisMonthRupees + 1_000);
    expect(after.earnedThisMonthRupees).toBe(before.earnedThisMonthRupees);
  });

  it('brokerFactRows always carry the commission/overprice split, so brokerWise is never NaN', () => {
    const s = world();
    const brokerId = brokerOf(s);
    const rows = brokerFactRows(s, brokerId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) for (const l of r.earningLines) expect(Number.isFinite(l.commissionPerMt + l.overpricePerMt)).toBe(true);
    const report = brokerWise(
      { truckLines: [], openSubOrders: [], bookedLines: [], brokers: [{ brokerId, brokerName: 'B', rows }] },
      { from: '2000-01-01', to: '2099-12-31', today: '2099-12-31', agedOrderDays: 10 },
    );
    expect(Number.isNaN(report.summary.commissionRupees)).toBe(false);
    expect(report.summary.commissionRupees + report.summary.overpriceRupees).toBe(report.summary.earnedRupees);
  });
});

describe('seed', () => {
  it('R.K. Agarwal has one NEFT payment of half his earnings (down to 1,000) from yesterday; Mittal has none', () => {
    const s = world();
    const earned = s.brokerLedger
      .filter((r) => r.brokerId === P.rkAgarwal && r.kind === 'earning')
      .reduce((n, r) => n + r.amountRupees, 0);
    expect(earned).toBeGreaterThan(0);
    const paid = Math.floor(earned / 2 / 1_000) * 1_000;
    const pays = s.brokerLedger.filter((r) => r.brokerId === P.rkAgarwal && r.kind === 'payment');
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({
      mode: 'neft',
      utr: '223614',
      tdsRupees: 0,
      paidRupees: paid,
      amountRupees: -paid,
      createdBy: U.rajesh,
      createdAt: toIso(NOW - DAY),
      paidOn: istDateOf(NOW - DAY),
    });
    expect(s.brokerLedger.some((r) => r.brokerId === P.mittal && r.kind === 'payment')).toBe(false);
  });
});
