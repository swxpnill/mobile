import { SAMPLE_WORLD, type Draft, type Order, type OrderList, type Party } from '@tonnage/shared';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../src/db/client.ts';
import { loadOrderGraph } from '../src/services/orderGraph.ts';
import { closeTestApps } from './helpers.ts';
import { COMPANY, canvasOrder, createMasters, krmOrder, napBrokerOrder, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res, type Side } from './support/parity.ts';

afterEach(closeTestApps);

let p: Parity;
/** The same masters on each side, by side. */
const masters = new Map<Side, Masters>();
const m = (s: Side): Masters => {
  const found = masters.get(s);
  if (!found) throw new Error(`no masters for ${s.name}`);
  return found;
};

beforeEach(async () => {
  p = await buildParity();
  masters.clear();
  masters.set(p.mock, await createMasters(p.mock));
  masters.set(p.api, await createMasters(p.api));
});

/** Status and body of the mock's and the API's response, ids normalised (R2), must be equal. */
function expectSame([mock, api]: [Res, Res]): void {
  // Each side's ids are numbered on their own: equal bodies number alike.
  expect(normaliseIds(api)).toEqual(normaliseIds(mock));
}

/** Books the same body on both sides; both must answer 201. */
async function bookBoth(body: (m: Masters) => object): Promise<[Order, Order]> {
  const [mock, api] = await p.both('POST', () => '/v1/orders', (s) => ({ body: body(m(s)) }));
  expect(mock.status, JSON.stringify(mock.body)).toBe(201);
  expect(api.status, JSON.stringify(api.body)).toBe(201);
  expectSame([mock, api]);
  return [mock.body as Order, api.body as Order];
}

/** A dispatched truck (with a transporter) on the KRM sub-order and an open one on the AIP 12 m line. */
async function truckBoth(orders: Map<Side, Order>): Promise<void> {
  for (const side of [p.mock, p.api]) {
    const o = orders.get(side);
    const [aip, krm] = o?.subOrders ?? [];
    if (!aip || !krm) throw new Error('canvas order without two sub-orders');
    await side.addTruck({
      subOrderId: krm.id,
      state: 'dispatched',
      vehicleNo: 'CG 07 BR 8810',
      transporterId: m(side).transporter.id,
      tareKg: 12_000,
      plan: [{ orderLineId: krm.lines[0]!.id, plannedKg: 25_000 }],
      allocations: [{ orderLineId: krm.lines[0]!.id, netKg: 24_800 }],
    });
    await side.addTruck({
      subOrderId: aip.id,
      state: 'assigned',
      vehicleNo: 'CG 04 LT 6619',
      transporterId: m(side).transporter.id,
      plan: [{ orderLineId: aip.lines[0]!.id, plannedKg: 18_000 }],
    });
  }
}

describe('orders: create equals the mock (R2)', () => {
  it('the canonical body → the same order (number, sub-orders, prices, estimate), detail as owner and plant head', async () => {
    const [mock, api] = await bookBoth(canvasOrder);
    expect(api).toMatchObject({
      number: 'SO-2611-0001',
      status: 'open',
      // The contract's ₹38,64,200 with a ₹1,500 conversion on 16 mm too (the canvas has ₹1,000).
      estimatedValue: 3_874_200,
      brokerEarningEstimate: { commission: 12_600, overprice: 22_200, total: 34_800 },
      vehicleRequests: [],
    });
    expect(api.subOrders.map((s) => s.number)).toEqual(['SO-2611-0001-A', 'SO-2611-0001-B']);

    const detailPath = (s: Side) => `/v1/orders/${s === p.mock ? mock.id : api.id}`;
    expectSame(await p.both('GET', detailPath));
    expectSame(await p.both('GET', detailPath, () => ({ as: 'kiran' })));
    // The broker-only order: no customer, no addresses, billets.
    await bookBoth(napBrokerOrder);
  });

  it('refusals equal the mock (422 and 409 bodies) and use up no number', async () => {
    const bad: ((m: Masters) => object)[] = [
      // A broker as customer, an address of another party.
      (x) => ({ ...canvasOrder(x), customerId: x.broker.id }),
      (x) => ({ ...canvasOrder(x), shipToId: krmOrder(x).shipToId }),
      // An unknown product (a company id), a product the company does not make.
      (x) => ({ ...krmOrder(x), subOrders: [{ companyId: COMPANY.KRM, lines: [{ ...krmOrder(x).subOrders[0]!.lines[0]!, productId: COMPANY.AIP }] }] }),
      (x) => ({ ...krmOrder(x), subOrders: [{ companyId: COMPANY.NAP, lines: krmOrder(x).subOrders[0]!.lines }] }),
      // Schema-level: a customer order with a broker.
      (x) => ({ ...krmOrder(x), brokerId: x.broker.id }),
    ];
    for (const body of bad) {
      const [mock, api] = await p.both('POST', () => '/v1/orders', (s) => ({ body: body(m(s)) }));
      expect(mock.status).toBeGreaterThanOrEqual(400);
      expectSame([mock, api]);
    }
    // An inactive company.
    for (const side of [p.mock, p.api]) {
      const vsl = await side.call('GET', `/v1/companies/${COMPANY.NAP}`);
      const res = await side.call('PATCH', `/v1/companies/${COMPANY.NAP}`, {
        body: { version: (vsl.body as { version: number }).version, active: false },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expectSame(await p.both('POST', () => '/v1/orders', (s) => ({ body: napBrokerOrder(m(s)) })));
    const [, created] = await bookBoth(krmOrder);
    expect(created.number).toBe('SO-2611-0001');
  });
});

describe('orders: the list equals the mock (R2)', () => {
  it('three orders, a dispatched and an open truck: status, unit and search filters, sort, paging, plant head', async () => {
    const [canvasMock, canvasApi] = await bookBoth(canvasOrder);
    p.clock.advance(60_000);
    await bookBoth(krmOrder);
    p.clock.advance(60_000);
    await bookBoth(napBrokerOrder);
    await truckBoth(new Map([[p.mock, canvasMock], [p.api, canvasApi]]));

    const queries = [
      '',
      '?status=partly_dispatched',
      '?status=open',
      '?status=completed',
      `?companyId=${COMPANY.KRM}`,
      `?companyId=${COMPANY.KRM}&status=partly_dispatched`,
      `?companyId=${COMPANY.VSL}`,
      '?q=patel',
      '?q=0002',
      '?q=2611-0003',
      '?q=agarwal',
      '?q=nothing',
      '?sort=oldest',
      '?aged=false',
      '?aged=true',
    ];
    for (const q of queries) {
      const pair = await p.both('GET', () => `/v1/orders${q}`);
      expect(pair[1].status, `${q}: ${JSON.stringify(pair[1].body)}`).toBe(200);
      expectSame(pair);
    }
    const list = (await p.api.call('GET', '/v1/orders')).body as OrderList;
    expect(list.items.map((i) => [i.number, i.status])).toEqual([
      ['SO-2611-0003', 'open'],
      ['SO-2611-0002', 'open'],
      ['SO-2611-0001', 'partly_dispatched'],
    ]);
    expect(list.counts).toEqual({ all: 3, open: 2, partly_dispatched: 1, completed: 0, short_closed: 0, cancelled: 0 });

    // Plant head (Kiran, Siltara = AIP): only the canvas order, only its AIP part, no money.
    expectSame(await p.both('GET', () => '/v1/orders', () => ({ as: 'kiran' })));

    // Paging: follow each side's own cursor, one row at a time, both directions.
    for (const sort of ['newest', 'oldest']) {
      const cursors = new Map<Side, string | null>([[p.mock, null], [p.api, null]]);
      for (let page = 0; page < 3; page++) {
        const path = (s: Side) => {
          const c = cursors.get(s);
          return `/v1/orders?sort=${sort}&limit=1${c ? `&cursor=${encodeURIComponent(c)}` : ''}`;
        };
        const pair = await p.both('GET', path);
        expectSame(pair);
        cursors.set(p.mock, (pair[0].body as OrderList).nextCursor);
        cursors.set(p.api, (pair[1].body as OrderList).nextCursor);
      }
      expect(cursors.get(p.api)).toBeNull();
    }
    // A malformed cursor is the mock's 422.
    expectSame(await p.both('GET', () => '/v1/orders?cursor=nonsense'));
  });

  it('aged orders: flagged and filtered the same way after 11 days', async () => {
    await bookBoth(krmOrder);
    p.clock.advance(11 * 24 * 60 * 60_000);
    await bookBoth(canvasOrder);
    const aged = await p.both('GET', () => '/v1/orders?aged=true');
    expectSame(aged);
    expect((aged[1].body as OrderList).items.map((i) => [i.number, i.ageDays, i.isAged])).toEqual([['SO-2611-0001', 11, true]]);
    expectSame(await p.both('GET', () => '/v1/orders?aged=false'));
  });
});

describe('orders: detail and duplicate', () => {
  it('detail with trucks equals the mock (dispatched, reserved, open trucks, dispatched count)', async () => {
    const [mo, ao] = await bookBoth(canvasOrder);
    await truckBoth(new Map([[p.mock, mo], [p.api, ao]]));
    const ids = new Map<Side, string>([[p.mock, mo.id], [p.api, ao.id]]);
    const pair = await p.both('GET', (s) => `/v1/orders/${ids.get(s)}`);
    expectSame(pair);
    const o = pair[1].body as Order;
    expect(o.status).toBe('partly_dispatched');
    expect(o.subOrders[1]).toMatchObject({ dispatchedTrucks: 1, status: 'partly_dispatched' });
    expect(o.subOrders[0]?.lines[0]).toMatchObject({ reservedKg: 18_000, pendingKg: 24_000 });
    expect(o.subOrders[0]?.openTrucks.map((t) => t.vehicleNo)).toEqual(['CG 04 LT 6619']);
  });

  it('404 for a random, a malformed and another tenant’s id, and for a plant head outside it', async () => {
    const [, api] = await bookBoth(krmOrder);
    for (const path of ['/v1/orders/019a4c00-0fff-7000-8000-000000000999', '/v1/orders/not-a-uuid']) {
      expect((await p.api.call('GET', path)).status).toBe(404);
    }
    const kiran = await p.api.call('GET', `/v1/orders/${api.id}`, { as: 'kiran' });
    expect(kiran).toEqual({ status: 404, body: { code: 'NOT_FOUND', message: expect.any(String) } });
    const dup = await p.api.call('POST', `/v1/orders/${api.id}/duplicate`, { as: 'priya' });
    expect(dup.status).toBe(201);
  });

  it('duplicate → the same draft as the mock; booking it makes a new order with the same lines and a new number', async () => {
    const [mo, ao] = await bookBoth(canvasOrder);
    const ids = new Map<Side, string>([[p.mock, mo.id], [p.api, ao.id]]);
    const pair = await p.both('POST', (s) => `/v1/orders/${ids.get(s)}/duplicate`);
    expect(pair[1].status, JSON.stringify(pair[1].body)).toBe(201);
    expectSame(pair);
    const draft = pair[1].body as Draft;
    const copy = await p.api.call('POST', '/v1/orders', { body: { ...draft.payload, draftId: draft.id } });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const c = copy.body as Order;
    expect(c.number).toBe('SO-2611-0002');
    expect(c.estimatedValue).toBe(ao.estimatedValue);
    const linesOf = (o: Order) =>
      o.subOrders.map((s) => [s.companyCode, s.lines.map((l) => [l.productId, l.length, l.orderedKg, l.rate, l.rateEdited, l.overpricePerMt])]);
    expect(linesOf(c)).toEqual(linesOf(ao));
    // Booking from the draft consumed it.
    const drafts = await p.t.ownerDb.$client.query<{ n: number }>('select count(*)::int as n from drafts');
    expect(drafts.rows[0]?.n).toBe(0);
  });
});

describe('orders: party figures and guards equal the mock (Task 2 carry-overs)', () => {
  it('party stats (open, pending, FY dispatched) and transporter trips', async () => {
    const [mo, ao] = await bookBoth(canvasOrder);
    await bookBoth(krmOrder);
    await truckBoth(new Map([[p.mock, mo], [p.api, ao]]));
    // The mock also holds its built-in SAMPLE_MASTERS: compare the parties these tests made.
    expectSame(await p.both('GET', () => '/v1/parties?q=test'));
    for (const who of ['shubham', 'broker', 'transporter', 'patel'] as const) {
      const pair = await p.both('GET', (s) => `/v1/parties/${m(s)[who].id}`);
      expectSame(pair);
    }
    const broker = (await p.api.call('GET', `/v1/parties/${m(p.api).broker.id}`)).body as Party;
    expect(broker.stats).toEqual({ openOrders: 1, pendingKg: 84_000 - 24_800, fyDispatchedKg: 24_800 });
    const transporter = (await p.api.call('GET', `/v1/parties/${m(p.api).transporter.id}`)).body as Party;
    expect(transporter.stats).toMatchObject({ tripsThisMonth: 1, vehiclesSeen: 2, recentVehicles: ['CG 04 LT 6619', 'CG 07 BR 8810'] });
  });

  it('PATCH dropping an address an order ships to → 409 PARTY_IN_USE (the mock’s body), nothing changed', async () => {
    await bookBoth(canvasOrder);
    const pair = await p.both('PATCH', (s) => `/v1/parties/${m(s).shubham.id}`, (s) => {
      const x = m(s).shubham;
      return {
        body: {
          type: x.type,
          name: x.name,
          gstin: x.gstin,
          city: x.city,
          defaultCommissionPerMt: x.defaultCommissionPerMt,
          paymentTermsText: x.paymentTermsText,
          isSelfTransporter: x.isSelfTransporter,
          contacts: x.contacts,
          // Keeps the bill-to and the Butibori yard (made the default), drops Hingna.
          addresses: x.addresses
            .filter((a) => a.label !== 'Hingna MIDC site')
            .map((a) => ({ ...a, isDefault: a.kind === 'bill_to' || a.label === 'Butibori yard' })),
          active: true,
          version: x.version,
        },
      };
    });
    expect(pair[1].status).toBe(409);
    expectSame(pair);
    const after = (await p.api.call('GET', `/v1/parties/${m(p.api).shubham.id}`)).body as Party;
    expect(after.version).toBe(1);
    expect(after.addresses.map((a) => a.label)).toEqual(['Bill to', 'Hingna MIDC site', 'Butibori yard']);
  });

  it('deactivating a company with an open sub-order → 409 COMPANY_HAS_OPEN_ORDERS, as the mock', async () => {
    await bookBoth(canvasOrder);
    const pair = await p.both('PATCH', () => `/v1/companies/${COMPANY.KRM}`, () => ({ body: { version: 1, active: false } }));
    expect(pair[1].status).toBe(409);
    expectSame(pair);
  });
});

describe('loadOrderGraph (Ruling 4)', () => {
  it('six queries for any number of orders, whatever their trucks (no N+1); unknown ids are absent', async () => {
    const [mo, ao] = await bookBoth(canvasOrder);
    await bookBoth(krmOrder);
    await bookBoth(napBrokerOrder);
    await truckBoth(new Map([[p.mock, mo], [p.api, ao]]));
    const ids = ((await p.api.call('GET', '/v1/orders')).body as OrderList).items.map((i) => i.id);
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    try {
      await withTenant(p.t.db, SAMPLE_WORLD.tenant.id, async (tx) => {
        spy.mockClear();
        const graphs = await loadOrderGraph(tx, [...ids, '019a4c00-0fff-7000-8000-000000000999']);
        expect(spy).toHaveBeenCalledTimes(6);
        expect([...graphs.keys()]).toEqual(ids);
        const canvas = graphs.get(ao.id);
        expect(canvas?.subOrders.map((s) => [s.sub.suffix, s.lines.length, s.trucks.length])).toEqual([
          ['A', 3, 1],
          ['B', 1, 1],
        ]);
        spy.mockClear();
        expect((await loadOrderGraph(tx, [])).size).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      });
    } finally {
      spy.mockRestore();
    }
  });
});
