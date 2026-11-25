import { SAMPLE_WORLD, type ActivityEntry, type DeletePreview, type Length, type Order } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as effects from '../src/services/orderEffects.ts';
import { closeTestApps } from './helpers.ts';
import { waitForLockWaiters } from './support/lockWait.ts';
import { COMPANY, addressId, canvasOrder, createMasters, krmOrder, type Masters } from './support/masters.ts';
import { normaliseIds } from './support/normalise.ts';
import { buildParity, type Parity, type Res, type Side } from './support/parity.ts';

afterEach(() => {
  vi.restoreAllMocks();
  return closeTestApps();
});

let p: Parity;
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

/** R2: status and body equal once ids are normalised (each side numbered on its own). */
function expectSame([mock, api]: [Res, Res]): void {
  expect(normaliseIds(api)).toEqual(normaliseIds(mock));
}

/** Per side, the value of the same thing (an order, an id). */
type BySide<T> = Map<Side, T>;
const of = <T>(x: BySide<T>, s: Side): T => {
  const v = x.get(s);
  if (v === undefined) throw new Error(`nothing for ${s.name}`);
  return v;
};

/** Books the same body on both sides (both 201, equal). */
async function bookBoth(body: (m: Masters) => object): Promise<BySide<Order>> {
  const [mock, api] = await p.both('POST', () => '/v1/orders', (s) => ({ body: body(m(s)) }));
  expect(mock.status, JSON.stringify(mock.body)).toBe(201);
  expect(api.status, JSON.stringify(api.body)).toBe(201);
  expectSame([mock, api]);
  return new Map([[p.mock, mock.body as Order], [p.api, api.body as Order]]);
}

/** Runs the same write on both sides, asserts the mock's status and equal bodies, returns the API's body. */
async function sameOn(
  method: 'PATCH' | 'POST' | 'DELETE' | 'GET',
  path: (s: Side) => string,
  opts: (s: Side) => { as?: 'rajesh' | 'priya' | 'kiran'; body?: unknown },
  status: number,
): Promise<[Res, Res]> {
  const pair = await p.both(method, path, opts);
  expect(pair[0].status, `mock: ${JSON.stringify(pair[0].body)}`).toBe(status);
  expectSame(pair);
  return pair;
}

/** The latest order on both sides (GET, equal). */
async function refresh(orders: BySide<Order>): Promise<BySide<Order>> {
  const [mock, api] = await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}`, () => ({}), 200);
  return new Map([[p.mock, mock.body as Order], [p.api, api.body as Order]]);
}

interface LineIn {
  productId: string;
  length: Length;
  orderedKg: number;
  typedRate: number | null;
  overpricePerMt: number;
}
const line = (productId: string, o: Partial<LineIn> = {}): LineIn => ({
  productId,
  length: { value: 12, unit: 'm' },
  orderedKg: 40_000,
  typedRate: 46_500,
  overpricePerMt: 0,
  ...o,
});

/** Like the contract's Patel order: KRM, direct, three lines. */
const patelOrder = (x: Masters) => ({
  draftId: null,
  type: 'customer',
  customerId: x.patel.id,
  brokerId: null,
  commissionPerMt: null,
  billToId: addressId(x.patel, 'Bill to'),
  shipToId: addressId(x.patel, 'Urla yard'),
  pricingMethod: 'direct',
  basicRate: null,
  subOrders: [
    {
      companyId: COMPANY.KRM,
      lines: [
        line(x.tmt16.id),
        line(x.tmt12.id, { orderedKg: 50_000, typedRate: 46_000 }),
        line(x.tmt16.id, { length: { value: 6, unit: 'm' }, orderedKg: 30_000, typedRate: 45_800 }),
      ],
    },
  ],
  notify: { customer: true, broker: false },
});

/** 28.400 MT dispatched on line 0; a loading truck planned 6 MT on line 0 and 20 MT on line 2. */
async function patelInProgress(): Promise<BySide<Order>> {
  const booked = await bookBoth(patelOrder);
  for (const s of [p.mock, p.api]) {
    const sub = of(booked, s).subOrders[0]!;
    const [l0, , l2] = sub.lines;
    await s.addTruck({
      subOrderId: sub.id,
      state: 'dispatched',
      vehicleNo: 'CG 04 PQ 7781',
      tareKg: 12_020,
      plan: [{ orderLineId: l0!.id, plannedKg: 28_000 }],
      allocations: [{ orderLineId: l0!.id, netKg: 28_400 }],
    });
    await s.addTruck({
      subOrderId: sub.id,
      state: 'loading',
      vehicleNo: 'CG 07 BR 8810',
      tareKg: 12_460,
      plan: [{ orderLineId: l0!.id, plannedKg: 6_000 }, { orderLineId: l2!.id, plannedKg: 20_000 }],
    });
  }
  return refresh(booked);
}

/** The PATCH body that leaves the order as it is (the contract's `editBody`). */
function editBody(o: Order) {
  return {
    type: o.type,
    customerId: o.customer?.id ?? null,
    brokerId: o.broker?.id ?? null,
    commissionPerMt: o.commissionPerMtSnapshot ?? null,
    billToId: o.billTo?.id ?? null,
    shipToId: o.shipTo?.id ?? null,
    pricingMethod: o.pricingMethod,
    basicRate: o.basicRate ?? null,
    notify: o.notify,
    version: o.version,
    subOrders: o.subOrders.map((s) => ({
      id: s.id as string | undefined,
      companyId: s.companyId,
      lines: s.lines.map((l) => ({
        id: l.id as string | undefined,
        productId: l.productId,
        length: l.length,
        orderedKg: l.orderedKg,
        typedRate: o.pricingMethod === 'direct' || l.rateEdited ? (l.rate ?? null) : null,
        overpricePerMt: l.overpricePerMt ?? 0,
      })),
    })),
  };
}
type EditBody = ReturnType<typeof editBody>;
const withLine = (b: EditBody, si: number, li: number, change: Record<string, unknown>): EditBody => ({
  ...b,
  subOrders: b.subOrders.map((s, i) =>
    i === si ? { ...s, lines: s.lines.map((l, j) => (j === li ? { ...l, ...change } : l)) } : s,
  ),
});

const patch = (orders: BySide<Order>, body: (o: Order, s: Side) => unknown, as: 'rajesh' | 'priya' = 'rajesh', status = 200) =>
  sameOn('PATCH', (s) => `/v1/orders/${of(orders, s).id}`, (s) => ({ as, body: body(of(orders, s), s) }), status);

const shortCloseBody = (version: number, cancelOpenTrucks = false) => ({
  reason: 'Customer stopped lifting',
  note: '',
  cancelOpenTrucks,
  version,
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await p.t.ownerDb.$client.query(sql, params)).rows as T[];

/** Every order-side row and its version: a refused write must leave this unchanged. */
async function snapshot() {
  return {
    orders: await q('select id, version, suffixes_used, updated_at from orders order by id'),
    subOrders: await q('select id, version, close_kind, updated_at from sub_orders order by id'),
    lines: await q('select id, version, ordered_kg, closed_kg, updated_at from order_lines order by id'),
    trucks: await q('select id, version, state from trucks order by id'),
    plan: await q('select truck_id, order_line_id, planned_kg from truck_plan_lines order by truck_id, order_line_id'),
    activity: await q('select id from activity_log order by id'),
  };
}

describe('edit (PATCH /v1/orders/:id) equals the mock', () => {
  it('quantities, a new line, a new company (B), then dropping B and adding NAP gives C (never reused)', async () => {
    let orders = await patelInProgress();
    // City staff: 30 MT on the dispatched line (28.4 dispatched + 6 reserved → BELOW_RESERVED warning), a new line.
    const [, edited] = await patch(
      orders,
      (o, s) => {
        const b = withLine(withLine(editBody(o), 0, 0, { orderedKg: 30_000 }), 0, 2, { orderedKg: 35_000, typedRate: 46_000 });
        b.subOrders[0]!.lines.push({ ...line(m(s).tmt12.id, { length: { value: 6, unit: 'm' }, orderedKg: 10_000 }), id: undefined });
        return b;
      },
      'priya',
    );
    const e = edited.body as Order;
    expect(e.warnings).toEqual([{ lineId: e.subOrders[0]!.lines[0]!.id, code: 'BELOW_RESERVED' }]);
    expect(e.subOrders[0]!.lines.map((l) => [l.orderedKg, l.version])).toEqual([[30_000, 2], [50_000, 1], [35_000, 2], [10_000, 1]]);
    expect(e.version).toBe(2);

    orders = await refresh(orders);
    const [, withAip] = await patch(orders, (o, s) => {
      const b = editBody(o);
      b.subOrders.push({ id: undefined, companyId: COMPANY.AIP, lines: [{ ...line(m(s).tmt12.id), id: undefined }] });
      return b;
    });
    expect((withAip.body as Order).subOrders.map((x) => x.number)).toEqual(['SO-2611-0001-A', 'SO-2611-0001-B']);

    orders = await refresh(orders);
    const [, swapped] = await patch(orders, (o, s) => {
      const b = editBody(o);
      b.subOrders = [b.subOrders[0]!, { id: undefined, companyId: COMPANY.NAP, lines: [{ ...line(m(s).billet.id), id: undefined }] }];
      return b;
    });
    expect((swapped.body as Order).subOrders.map((x) => [x.suffix, x.companyCode])).toEqual([['A', 'KRM'], ['C', 'NAP']]);
    expect((await q<{ suffixes_used: number }>('select suffixes_used from orders'))[0]?.suffixes_used).toBe(3);

    // Removing an undispatched line that is not on an open truck (line 1, 50 MT) deletes it.
    orders = await refresh(orders);
    const [, dropped] = await patch(orders, (o) => {
      const b = editBody(o);
      b.subOrders[0]!.lines.splice(1, 1);
      return b;
    });
    expect((dropped.body as Order).subOrders[0]!.lines).toHaveLength(3);
    await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}/activity`, () => ({}), 200);
  });

  it('refusals equal the mock and write nothing (Review Focus 4: below dispatched)', async () => {
    const orders = await patelInProgress();
    const before = await snapshot();
    const l0 = (o: Order) => o.subOrders[0]!.lines[0]!;
    const cases: [(o: Order, s: Side) => unknown, 'rajesh' | 'priya', number][] = [
      [(o) => withLine(editBody(o), 0, 0, { orderedKg: 28_000 }), 'priya', 409], // BELOW_DISPATCHED
      [(o) => withLine(editBody(o), 0, 0, { orderedKg: 28_000 }), 'rajesh', 409], // BELOW_DISPATCHED, owner too
      [(o) => withLine(editBody(o), 0, 0, { typedRate: 47_000 }), 'priya', 409], // LINE_RATE_LOCKED
      [(o, s) => withLine(editBody(o), 0, 0, { productId: m(s).tmt12.id }), 'rajesh', 409], // LINE_HAS_DISPATCHES
      [(o) => ({ ...editBody(o), subOrders: [{ ...editBody(o).subOrders[0]!, lines: editBody(o).subOrders[0]!.lines.slice(0, 2) }] }), 'rajesh', 409], // OPEN_TRUCKS (line 2 on the loading truck)
      [(o) => ({ ...editBody(o), subOrders: [{ ...editBody(o).subOrders[0]!, lines: editBody(o).subOrders[0]!.lines.slice(1) }] }), 'rajesh', 409], // LINE_HAS_DISPATCHES (removing line 0)
      [(o) => withLine(editBody(o), 0, 1, { id: uuidv7() }), 'rajesh', 409], // LINE_NOT_ON_ORDER
      [(o) => ({ ...editBody(o), subOrders: [{ ...editBody(o).subOrders[0]!, companyId: COMPANY.AIP }] }), 'rajesh', 422], // company of a sub-order
      [
        (o) => {
          // Line 0 sent under a new AIP sub-order: lines never change company.
          const b = editBody(o);
          return { ...b, subOrders: [b.subOrders[0]!, { id: undefined, companyId: COMPANY.AIP, lines: [b.subOrders[0]!.lines[0]!] }] };
        },
        'rajesh',
        422,
      ],
      [(o) => ({ ...withLine(editBody(o), 0, 1, { orderedKg: 55_000 }), version: o.version + 1 }), 'rajesh', 409], // STALE
      [(o) => ({ ...editBody(o), shipToId: uuidv7() }), 'rajesh', 422], // reference checks
    ];
    const codes: string[] = [];
    for (const [body, as, status] of cases) {
      const [, api] = await patch(orders, body, as, status);
      codes.push((api.body as { code: string }).code);
    }
    expect(codes).toEqual([
      'BELOW_DISPATCHED',
      'BELOW_DISPATCHED',
      'LINE_RATE_LOCKED',
      'LINE_HAS_DISPATCHES',
      'OPEN_TRUCKS',
      'LINE_HAS_DISPATCHES',
      'LINE_NOT_ON_ORDER',
      'VALIDATION',
      'VALIDATION',
      'STALE',
      'VALIDATION',
    ]);
    expect(await snapshot()).toEqual(before);
    expect(l0(of(orders, p.api)).dispatchedKg).toBe(28_400);
    // Unknown order: 404 on both.
    await sameOn('PATCH', () => `/v1/orders/${uuidv7()}`, (s) => ({ body: editBody(of(orders, s)) }), 404);
  });

  it('a line of a removed sub-order on a cancelled truck: the sub-order, its line and the cancelled truck go (no dangling rows)', async () => {
    let orders = await bookBoth(canvasOrder);
    for (const s of [p.mock, p.api]) {
      const krm = of(orders, s).subOrders[1]!;
      await s.addTruck({ subOrderId: krm.id, state: 'cancelled', vehicleNo: 'CG 04 AA 1111', plan: [{ orderLineId: krm.lines[0]!.id, plannedKg: 5_000 }] });
      const aip = of(orders, s).subOrders[0]!;
      await s.addTruck({ subOrderId: aip.id, state: 'cancelled', vehicleNo: 'CG 04 AA 2222', plan: [{ orderLineId: aip.lines[1]!.id, plannedKg: 5_000 }] });
    }
    orders = await refresh(orders);
    await patch(orders, (o) => {
      const b = editBody(o);
      // Drop KRM, and the AIP 6 m line.
      return { ...b, subOrders: [{ ...b.subOrders[0]!, lines: [b.subOrders[0]!.lines[0]!, b.subOrders[0]!.lines[2]!] }] };
    });
    expect(await q('select vehicle_no from trucks order by vehicle_no')).toEqual([{ vehicle_no: 'CG 04 AA 2222' }]);
    expect(await q('select count(*)::int as n from truck_plan_lines')).toEqual([{ n: 0 }]);
    expect(await q('select suffix from sub_orders')).toEqual([{ suffix: 'A' }]);
    await refresh(orders);
  });
});

describe('short close and reopen equal the mock', () => {
  it('OPEN_TRUCKS lists the loading truck; confirmed, it is cancelled; ALREADY_CLOSED; ORDER_LOCKED; reopen owner only; NOT_CLOSED', async () => {
    let orders = await patelInProgress();
    const sub = (s: Side) => of(orders, s).subOrders[0]!;
    const close = (cancel: boolean, version: (s: Side) => number, status: number) =>
      sameOn('POST', (s) => `/v1/sub-orders/${sub(s).id}/short-close`, (s) => ({ body: shortCloseBody(version(s), cancel) }), status);

    const [, refused] = await close(false, (s) => sub(s).version, 409);
    expect(refused.body).toMatchObject({ code: 'OPEN_TRUCKS', details: { trucks: [{ vehicleNo: 'CG 07 BR 8810', state: 'loading', tareKg: 12_460 }] } });
    await close(true, (s) => sub(s).version + 1, 409); // STALE
    const [, closed] = await close(true, (s) => sub(s).version, 200);
    const c = closed.body as Order;
    expect(c.subOrders[0]!.lines.map((l) => [l.closedKg, l.pendingKg, l.reservedKg])).toEqual([[11_600, 0, 0], [50_000, 0, 0], [30_000, 0, 0]]);
    expect([c.status, c.subOrders[0]!.closeKind, c.subOrders[0]!.version, c.version]).toEqual(['short_closed', 'short_close', 2, 2]);
    orders = await refresh(orders);
    await close(true, (s) => sub(s).version, 409); // ALREADY_CLOSED
    await patch(orders, (o) => withLine(editBody(o), 0, 1, { orderedKg: 60_000 }), 'rajesh', 409); // ORDER_LOCKED

    const reopen = (as: 'rajesh' | 'priya', status: number) =>
      sameOn('POST', (s) => `/v1/sub-orders/${sub(s).id}/reopen`, (s) => ({ as, body: { version: sub(s).version } }), status);
    await reopen('priya', 403);
    const [, back] = await reopen('rajesh', 200);
    expect((back.body as Order).subOrders[0]!.lines.map((l) => l.pendingKg)).toEqual([11_600, 50_000, 30_000]);
    expect((back.body as Order).status).toBe('partly_dispatched');
    orders = await refresh(orders);
    await reopen('rajesh', 409); // NOT_CLOSED
    await sameOn('POST', () => `/v1/sub-orders/${uuidv7()}/reopen`, () => ({ body: { version: 1 } }), 404);
    await sameOn('POST', () => `/v1/sub-orders/${uuidv7()}/short-close`, () => ({ body: shortCloseBody(1) }), 404);
    await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}/activity`, () => ({}), 200);
  });

  it('nothing dispatched → Cancelled; a completed sub-order → ALREADY_CLOSED', async () => {
    const orders = await bookBoth(krmOrder);
    const [, cancelled] = await sameOn(
      'POST',
      (s) => `/v1/sub-orders/${of(orders, s).subOrders[0]!.id}/short-close`,
      (s) => ({ as: 'priya', body: { ...shortCloseBody(of(orders, s).subOrders[0]!.version), note: 'Rate dispute' } }),
      200,
    );
    expect([(cancelled.body as Order).status, (cancelled.body as Order).subOrders[0]!.closeNote]).toEqual(['cancelled', 'Rate dispute']);

    const done = await bookBoth(krmOrder);
    for (const s of [p.mock, p.api]) {
      const sub = of(done, s).subOrders[0]!;
      await s.addTruck({
        subOrderId: sub.id,
        state: 'dispatched',
        vehicleNo: 'CG 04 PQ 7781',
        tareKg: 12_000,
        plan: [{ orderLineId: sub.lines[0]!.id, plannedKg: 24_000 }],
        allocations: [{ orderLineId: sub.lines[0]!.id, netKg: 24_000 }],
      });
    }
    await sameOn('POST', (s) => `/v1/sub-orders/${of(done, s).subOrders[0]!.id}/short-close`, (s) => ({ body: shortCloseBody(of(done, s).subOrders[0]!.version) }), 409);
  });

  it('two open trucks with cancelOpenTrucks: both cancelled with the reason; activity meta.trucksCancelled = 2', async () => {
    const orders = await bookBoth(krmOrder);
    for (const s of [p.mock, p.api]) {
      const sub = of(orders, s).subOrders[0]!;
      for (const [state, vehicleNo] of [['assigned', 'CG 04 AA 0001'], ['at_gate', 'CG 04 AA 0002']] as const) {
        await s.addTruck({ subOrderId: sub.id, state, vehicleNo, plan: [{ orderLineId: sub.lines[0]!.id, plannedKg: 5_000 }] });
      }
    }
    await sameOn(
      'POST',
      (s) => `/v1/sub-orders/${of(orders, s).subOrders[0]!.id}/short-close`,
      (s) => ({ body: shortCloseBody(of(orders, s).subOrders[0]!.version, true) }),
      200,
    );
    expect(await q('select state, cancel_reason, cancelled_by, cancelled_at, version from trucks order by vehicle_no')).toEqual(
      [1, 2].map(() => ({
        state: 'cancelled',
        cancel_reason: 'Order short closed',
        cancelled_by: SAMPLE_WORLD.ids.users.rajesh,
        cancelled_at: new Date(p.clock.now()),
        version: 2,
      })),
    );
    const [, acts] = await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}/activity`, () => ({}), 200);
    expect((acts.body as ActivityEntry[])[0]).toMatchObject({ action: 'order.sub_cancelled', meta: { trucksCancelled: 2, suffix: 'A' } });
  });
});

describe('move quantity equals the mock', () => {
  it('to a company without a sub-order (new suffix), merging into a matching line, emptying the source, and back (C)', async () => {
    let orders = await bookBoth(krmOrder);
    const move = (body: (o: Order) => object, status = 200) =>
      sameOn('POST', (s) => `/v1/orders/${of(orders, s).id}/move-quantity`, (s) => ({ body: body(of(orders, s)) }), status);
    const from = (o: Order) => o.subOrders[0]!.lines[0]!;

    const [, first] = await move((o) => ({ fromLineId: from(o).id, toCompanyId: COMPANY.AIP, kg: 10_000, version: o.version }));
    expect((first.body as Order).subOrders.map((s) => [s.suffix, s.companyCode, s.lines.map((l) => l.orderedKg)])).toEqual([
      ['A', 'KRM', [14_000]],
      ['B', 'AIP', [10_000]],
    ]);
    orders = await refresh(orders);
    const [, merged] = await move((o) => ({ fromLineId: from(o).id, toCompanyId: COMPANY.AIP, kg: 4_000, version: o.version }));
    expect((merged.body as Order).subOrders.map((s) => s.lines.map((l) => [l.orderedKg, l.version]))).toEqual([[[10_000, 3]], [[14_000, 2]]]);
    orders = await refresh(orders);
    // All that is left on KRM: the line and the KRM sub-order go.
    const [, emptied] = await move((o) => ({ fromLineId: from(o).id, toCompanyId: COMPANY.AIP, kg: 10_000, version: o.version }));
    expect((emptied.body as Order).subOrders.map((s) => [s.suffix, s.companyCode, s.lines.map((l) => l.orderedKg)])).toEqual([['B', 'AIP', [24_000]]]);
    orders = await refresh(orders);
    const [, back] = await move((o) => ({ fromLineId: from(o).id, toCompanyId: COMPANY.KRM, kg: 1_000, version: o.version }));
    expect((back.body as Order).subOrders.map((s) => s.number)).toEqual(['SO-2611-0001-B', 'SO-2611-0001-C']);
    await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}/activity`, () => ({}), 200);
  });

  it('refusals equal the mock and write nothing (Review Focus 4: more than is undispatched)', async () => {
    let orders = await patelInProgress();
    const move = (body: (o: Order, s: Side) => object, status: number) =>
      sameOn('POST', (s) => `/v1/orders/${of(orders, s).id}/move-quantity`, (s) => ({ body: body(of(orders, s), s) }), status);
    const l0 = (o: Order) => o.subOrders[0]!.lines[0]!; // 40 ordered, 28.4 dispatched, 6 reserved → 5.6 available
    const before = await snapshot();
    const [, exceeds] = await move((o) => ({ fromLineId: l0(o).id, toCompanyId: COMPANY.AIP, kg: 6_000, version: o.version }), 409);
    expect(exceeds.body).toMatchObject({ code: 'MOVE_EXCEEDS_AVAILABLE', details: { availableKg: 5_600 } });
    await move((o) => ({ fromLineId: l0(o).id, toCompanyId: COMPANY.NAP, kg: 1_000, version: o.version }), 409); // PRODUCT_NOT_FOR_COMPANY
    await move((o) => ({ fromLineId: l0(o).id, toCompanyId: COMPANY.KRM, kg: 1_000, version: o.version }), 422); // same company
    await move((o) => ({ fromLineId: l0(o).id, toCompanyId: uuidv7(), kg: 1_000, version: o.version }), 422); // unknown company
    await move((o) => ({ fromLineId: uuidv7(), toCompanyId: COMPANY.AIP, kg: 1_000, version: o.version }), 422); // not on the order
    await move((o) => ({ fromLineId: l0(o).id, toCompanyId: COMPANY.AIP, kg: 1_000, version: o.version + 1 }), 409); // STALE
    expect(await snapshot()).toEqual(before);

    // An inactive company (checked before the product).
    for (const s of [p.mock, p.api]) {
      const vsl = await s.call('GET', `/v1/companies/${COMPANY.VSL}`);
      const res = await s.call('PATCH', `/v1/companies/${COMPANY.VSL}`, { body: { version: (vsl.body as { version: number }).version, active: false } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    await move((o) => ({ fromLineId: l0(o).id, toCompanyId: COMPANY.VSL, kg: 1_000, version: o.version }), 409);

    // From a closed sub-order: ORDER_LOCKED.
    await sameOn('POST', (s) => `/v1/sub-orders/${of(orders, s).subOrders[0]!.id}/short-close`, (s) => ({ body: shortCloseBody(of(orders, s).subOrders[0]!.version, true) }), 200);
    orders = await refresh(orders);
    const [, locked] = await move((o) => ({ fromLineId: l0(o).id, toCompanyId: COMPANY.AIP, kg: 1_000, version: o.version }), 409);
    expect(locked.body).toMatchObject({ code: 'ORDER_LOCKED' });
  });
});

describe('delete-preview and hard delete', () => {
  it('preview and refusals equal the mock; the delete leaves zero rows for the order in every table, and calls afterOrderDeleted', async () => {
    const orders = await patelInProgress();
    const other = await bookBoth(krmOrder);
    const id = (s: Side) => of(orders, s).id;
    const [, preview] = await sameOn('GET', (s) => `/v1/orders/${id(s)}/delete-preview`, () => ({}), 200);
    expect(preview.body as DeletePreview).toEqual({ subOrders: 1, lines: 3, trucks: 2, dispatchedKg: 28_400, weighments: 3 });
    await sameOn('GET', (s) => `/v1/orders/${id(s)}/delete-preview`, () => ({ as: 'priya' }), 403);
    await sameOn('DELETE', (s) => `/v1/orders/${id(s)}`, () => ({ body: { confirmNumber: 'SO-2611-9999' } }), 409);
    await sameOn('DELETE', (s) => `/v1/orders/${id(s)}`, (s) => ({ as: 'priya', body: { confirmNumber: of(orders, s).number } }), 403);

    // Everything that points at the order, before.
    const api = of(orders, p.api);
    const sub = api.subOrders[0]!;
    const truckIds = (await q<{ id: string; plant_id: string }>('select id, plant_id from trucks where sub_order_id = $1 order by id', [sub.id]));
    const ids = [api.id, sub.id, ...sub.lines.map((l) => l.id), ...truckIds.map((t) => t.id)];
    expect(await rowsMentioning(ids)).not.toEqual({});

    const spy = vi.spyOn(effects, 'afterOrderDeleted');
    await sameOn('DELETE', (s) => `/v1/orders/${id(s)}`, (s) => ({ body: { confirmNumber: ` ${of(orders, s).number.toLowerCase()} ` } }), 204);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toEqual({ orderId: api.id, trucks: truckIds.map((t) => ({ id: t.id, plantId: t.plant_id })) });
    expect(await rowsMentioning(ids)).toEqual({});
    // The other order is untouched: one order, sub-order and line left, no trucks.
    const left: Record<string, number> = {};
    for (const table of ['orders', 'sub_orders', 'order_lines', 'trucks', 'truck_plan_lines', 'truck_allocations']) {
      left[table] = (await q<{ n: number }>(`select count(*)::int as n from ${table}`))[0]?.n ?? -1;
    }
    expect(left).toEqual({ orders: 1, sub_orders: 1, order_lines: 1, trucks: 0, truck_plan_lines: 0, truck_allocations: 0 });
    expect(await q('select action from activity_log where entity_id = $1', [of(other, p.api).id])).toEqual([{ action: 'order.created' }]);
    await sameOn('GET', (s) => `/v1/orders/${id(s)}`, () => ({}), 404);
    await sameOn('GET', (s) => `/v1/orders/${id(s)}/activity`, () => ({}), 404);
    await sameOn('GET', (s) => `/v1/orders/${id(s)}/delete-preview`, () => ({}), 404);
  });

  it('with allowHardDeleteAfterDispatch off: HARD_DELETE_DISABLED, nothing removed', async () => {
    const orders = await patelInProgress();
    for (const s of [p.mock, p.api]) {
      const res = await s.call('PATCH', '/v1/settings', { body: { allowHardDeleteAfterDispatch: false } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const before = await snapshot();
    await sameOn('DELETE', (s) => `/v1/orders/${of(orders, s).id}`, (s) => ({ body: { confirmNumber: of(orders, s).number } }), 409);
    expect(await snapshot()).toEqual(before);
  });
});

/** Rows of any public table with a uuid column equal to one of `ids`, by table and column. */
async function rowsMentioning(ids: string[]): Promise<Record<string, number>> {
  const cols = await q<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type = 'uuid' order by table_name, column_name`,
  );
  const out: Record<string, number> = {};
  for (const c of cols) {
    const [row] = await q<{ n: number }>(`select count(*)::int as n from "${c.table_name}" where "${c.column_name}" = any($1::uuid[])`, [ids]);
    if ((row?.n ?? 0) > 0) out[`${c.table_name}.${c.column_name}`] = row?.n ?? 0;
  }
  return out;
}

describe('activity', () => {
  it('newest first; a plant head sees nothing about sub-orders outside their plants (equals the mock)', async () => {
    const orders = await bookBoth(canvasOrder);
    const aip = (o: Order) => o.subOrders.find((s) => s.companyId === COMPANY.AIP)!;
    const krm = (o: Order) => o.subOrders.find((s) => s.companyId === COMPANY.KRM)!;
    const [, moved] = await sameOn(
      'POST',
      (s) => `/v1/orders/${of(orders, s).id}/move-quantity`,
      (s) => ({ body: { fromLineId: aip(of(orders, s)).lines[0]!.id, toCompanyId: COMPANY.KRM, kg: 1_000, version: of(orders, s).version } }),
      200,
    );
    p.clock.advance(60_000);
    const after = await refresh(orders);
    await sameOn('POST', (s) => `/v1/sub-orders/${krm(of(after, s)).id}/short-close`, (s) => ({ body: shortCloseBody(krm(of(after, s)).version, true) }), 200);
    p.clock.advance(60_000);
    await patch(await refresh(orders), (o) => editBody(o));
    const [, all] = await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}/activity`, () => ({}), 200);
    expect((all.body as ActivityEntry[]).map((e) => e.action)).toEqual(['order.edited', 'order.sub_cancelled', 'order.quantity_moved', 'order.created']);
    expect((all.body as ActivityEntry[])[0]).not.toHaveProperty('meta');
    expect((moved.body as Order).version).toBe(2);
    const [, kiran] = await sameOn('GET', (s) => `/v1/orders/${of(orders, s).id}/activity`, () => ({ as: 'kiran' }), 200);
    expect((kiran.body as ActivityEntry[]).map((e) => e.action)).toEqual(['order.edited', 'order.created']);
  });
});

describe('Review Focus 2: an edit racing a short close of the same sub-order', () => {
  /** Holds the order row on another connection, starts the requests one by one (each queued behind it), then lets go. */
  async function staged(orderId: string, steps: (() => Promise<Res>)[]): Promise<Res[]> {
    const holder = await p.t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from orders where id = $1 for update', [orderId]);
      const pending: Promise<Res>[] = [];
      for (const [i, step] of steps.entries()) {
        pending.push(step());
        await waitForLockWaiters(p.t.ownerDb, i + 1);
      }
      await holder.query('commit');
      return await Promise.all(pending);
    } finally {
      holder.release();
    }
  }

  /** The smallest raw pending (ordered − dispatched − closed) of any line: never below 0. */
  const minPendingKg = async () =>
    (
      await q<{ n: number }>(
        `select min(l.ordered_kg - l.closed_kg - coalesce((
           select sum(a.net_kg) from truck_allocations a join trucks t on t.id = a.truck_id
            where a.order_line_id = l.id and t.state = 'dispatched'), 0))::int as n
           from order_lines l`,
      )
    )[0]?.n ?? -1;

  it('short close first: the edit (same order version) gets 409 STALE; nothing pending afterwards', async () => {
    const orders = await patelInProgress();
    const o = of(orders, p.api);
    const sub = o.subOrders[0]!;
    const [close, edit] = await staged(o.id, [
      () => p.api.call('POST', `/v1/sub-orders/${sub.id}/short-close`, { body: shortCloseBody(sub.version, true) }),
      () => p.api.call('PATCH', `/v1/orders/${o.id}`, { body: withLine(editBody(o), 0, 1, { orderedKg: 60_000 }) }),
    ]);
    expect([close!.status, edit!.status, (edit!.body as { code: string }).code]).toEqual([200, 409, 'STALE']);
    const now = (await p.api.call('GET', `/v1/orders/${o.id}`)).body as Order;
    expect(now.subOrders[0]!.lines.map((l) => [l.orderedKg, l.pendingKg])).toEqual([[40_000, 0], [50_000, 0], [30_000, 0]]);
    expect(now.version).toBe(o.version + 1);
    expect(await minPendingKg()).toBe(0);
  });

  it('edit first: as on the mock, the short close (sub-order version unchanged by an edit) closes what the edit left; pending 0', async () => {
    const orders = await patelInProgress();
    const o = of(orders, p.api);
    const sub = o.subOrders[0]!;
    const [edit, close] = await staged(o.id, [
      () => p.api.call('PATCH', `/v1/orders/${o.id}`, { body: withLine(editBody(o), 0, 1, { orderedKg: 60_000 }) }),
      () => p.api.call('POST', `/v1/sub-orders/${sub.id}/short-close`, { body: shortCloseBody(sub.version, true) }),
    ]);
    expect([edit!.status, close!.status]).toEqual([200, 200]);
    // The same two calls, one after the other, on the mock.
    const mo = of(orders, p.mock);
    await p.mock.call('PATCH', `/v1/orders/${mo.id}`, { body: withLine(editBody(mo), 0, 1, { orderedKg: 60_000 }) });
    const mockClose = await p.mock.call('POST', `/v1/sub-orders/${mo.subOrders[0]!.id}/short-close`, { body: shortCloseBody(mo.subOrders[0]!.version, true) });
    expect(normaliseIds(close)).toEqual(normaliseIds(mockClose));
    expect((close!.body as Order).subOrders[0]!.lines.map((l) => [l.orderedKg, l.closedKg, l.pendingKg])).toEqual([
      [40_000, 11_600, 0],
      [60_000, 60_000, 0],
      [30_000, 30_000, 0],
    ]);
    expect(await minPendingKg()).toBe(0);
  });
});
