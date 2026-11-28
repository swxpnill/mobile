import { SAMPLE_MASTERS, SAMPLE_WORLD, type HttpMethod, type Role } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { seed } from '../../src/db/seed.ts';
import { drafts } from '../../src/db/schema/index.ts';
import { apiFixtures } from '../api-fixtures.ts';
import { fastifyTransport } from '../fastify-transport.ts';
import { bearerFor, ownerInsertParty, ownerInsertProduct, type TestApp } from '../helpers.ts';
import { ownerInsertOrderLine } from './orders.ts';
import { ownerInsertTruck } from './trucks.ts';

const C = SAMPLE_WORLD.ids.companies;
const PL = SAMPLE_WORLD.ids.plants;
const U = SAMPLE_WORLD.ids.users;
const P = SAMPLE_MASTERS.ids.parties;
const PR = SAMPLE_MASTERS.ids.products;
const A = SAMPLE_MASTERS.ids.addresses;

/** The person who plays each role in the generated tests (Kiran: Siltara, Ravi: Siltara). */
export const PERSON_FOR: Record<Role, string> = {
  owner: U.rajesh,
  city_staff: U.priya,
  plant_head: U.kiran,
  supervisor: U.ravi,
};

/** The kinds of `:id` the M1 and M2 routes take, read from the path. */
export type IdKind =
  | 'companies'
  | 'plants'
  | 'users'
  | 'parties'
  | 'products'
  | 'orders'
  | 'drafts'
  | 'sub-orders'
  | 'trucks'
  | 'weighment-rejections';

/** Which record a route's `:id` names: `/v1/orders/drafts/:id` is a draft, else the first segment. */
export function idKindOf(url: string): IdKind | null {
  if (!url.includes(':id')) return null;
  if (url.startsWith('/v1/orders/drafts/')) return 'drafts';
  const kind = url.split('/')[2];
  switch (kind) {
    case 'companies':
    case 'plants':
    case 'users':
    case 'parties':
    case 'products':
    case 'orders':
    case 'sub-orders':
    case 'trucks':
    case 'weighment-rejections':
      return kind;
    default:
      throw new Error(`no id kind for ${url}: add it to idKindOf`);
  }
}

export type Ids = Record<IdKind, string>;

const line = (o: Record<string, unknown> = {}) => ({
  productId: PR.tmt12,
  length: { value: 12, unit: 'm' },
  orderedKg: 24_000,
  typedRate: null,
  overpricePerMt: 300,
  ...o,
});

/** The canvas order on the seeded masters: AIP (Siltara) 2 lines + KRM (Borai) 1 line, via a broker. */
const CANVAS = {
  draftId: null,
  type: 'customer_broker',
  customerId: P.shubham,
  brokerId: P.rkAgarwal,
  commissionPerMt: 150,
  billToId: A.shubhamBill,
  shipToId: A.shubhamHingna,
  pricingMethod: 'basic_conversion',
  basicRate: 44_500,
  subOrders: [
    { companyId: C.AIP, lines: [line(), line({ productId: PR.tmt16, orderedKg: 20_000, typedRate: 46_100 })] },
    { companyId: C.KRM, lines: [line({ productId: PR.tmt16, length: { value: 40, unit: 'ft' }, orderedKg: 30_000 })] },
  ],
  notify: { customer: true, broker: true },
};

/** A direct-priced order on KRM (Borai) only: out of Siltara's scope. */
const KRM_ONLY = {
  ...CANVAS,
  type: 'customer',
  customerId: P.patel,
  brokerId: null,
  commissionPerMt: null,
  billToId: A.patelBill,
  shipToId: A.patelSite2,
  pricingMethod: 'direct',
  basicRate: null,
  subOrders: [{ companyId: C.KRM, lines: [line({ productId: PR.tmt20, typedRate: 46_000, overpricePerMt: 0 })] }],
  notify: { customer: true, broker: false },
};

/** Real records for every `:id` kind: in Siltara's scope, out of it, and in another tenant. */
export interface World {
  /** Records every role may name (a plant role sees them through Siltara); drafts per person. */
  inScope(role: Role): Ids;
  /** Same tenant, outside the role's scope (another plant; another person's draft), per kind. */
  otherScope(role: Role): Partial<Ids>;
  /** A second tenant's records: 404 for everyone. */
  otherTenant: Ids;
  /**
   * A valid body for each `:id` route that takes one, keyed `METHOD /v1/path`, built from the
   * in-scope records (their versions, lines and number), so a call passes validation and reaches
   * the record lookup: in scope it acts or refuses on business grounds, out of scope it is a 404.
   */
  bodies: Readonly<Record<string, unknown>>;
  /** Sends a request as the person playing `role`. */
  call(role: Role, method: HttpMethod, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/**
 * Truncates and seeds (org layer + SAMPLE_MASTERS), then books two orders through the API as the
 * owner (one with a Siltara sub-order carrying a dispatched and a weighed truck, one on Borai only),
 * a draft each for Rajesh, Priya and Amit, and a second tenant with one record of every kind.
 * With `history`, the canvas order also goes through an edit (a rate), a quantity move (Borai to
 * Siltara) and a short close of its Siltara sub-order, so its activity holds each kind of entry.
 */
export async function buildWorld(t: TestApp, opts: { history?: boolean } = {}): Promise<World> {
  await t.reset();
  await seed(t.ownerDb, t.clock);
  const transport = fastifyTransport(t.app);
  const headers = new Map<string, Record<string, string>>();
  const send = async (userId: string, method: HttpMethod, path: string, body?: unknown) => {
    let auth = headers.get(userId);
    if (!auth) {
      auth = await bearerFor(t, SAMPLE_WORLD.tenant.id, userId);
      headers.set(userId, auth);
    }
    const h: Record<string, string> = { ...auth };
    if (method !== 'GET') h['idempotency-key'] = uuidv7();
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await transport.request({ method, path, headers: h, body });
    return { status: res.status, body: res.body ?? null };
  };
  const created = async <T>(userId: string, path: string, body: unknown): Promise<T> => {
    const res = await send(userId, 'POST', path, body);
    if (res.status !== 201) throw new Error(`world: POST ${path} ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  };

  const canvasAtStart = await created<OrderView>(U.rajesh, '/v1/orders', CANVAS);
  const krm = await created<OrderView>(U.rajesh, '/v1/orders', KRM_ONLY);
  const subOf = (o: OrderView, companyId: string) => {
    const sub = o.subOrders.find((x) => x.companyId === companyId);
    if (!sub) throw new Error(`world: order ${o.number} has no sub-order for ${companyId}`);
    return sub;
  };
  const krmSub = subOf(krm, C.KRM);
  const aipAtStart = subOf(canvasAtStart, C.AIP);
  const [l0, l1] = aipAtStart.lines;
  if (!l0 || !l1) throw new Error('world: the AIP sub-order lacks its lines');
  const write = async (method: HttpMethod, path: string, body: unknown) => {
    const res = await send(U.rajesh, method, path, body);
    if (res.status !== 200) throw new Error(`world: ${method} ${path} ${res.status} ${JSON.stringify(res.body)}`);
  };
  const fetchCanvas = async () => (await send(U.rajesh, 'GET', `/v1/orders/${canvasAtStart.id}`)).body as OrderView;
  if (opts.history === true) {
    const edited = editBody(canvasAtStart);
    const rated = edited.subOrders.find((x) => x.companyId === C.AIP)?.lines[1];
    if (!rated) throw new Error('world: no AIP line to re-rate');
    rated.typedRate = 46_400;
    await write('PATCH', `/v1/orders/${canvasAtStart.id}`, edited);
    const afterEdit = await fetchCanvas();
    const krmLine = subOf(afterEdit, C.KRM).lines[0];
    if (!krmLine) throw new Error('world: the canvas KRM sub-order has no line');
    await write('POST', `/v1/orders/${canvasAtStart.id}/move-quantity`, {
      fromLineId: krmLine.id,
      toCompanyId: C.AIP,
      kg: 5_000,
      version: afterEdit.version,
    });
  }
  const siltaraTruck = await ownerInsertTruck(
    t.ownerDb,
    { subOrderId: aipAtStart.id, state: 'dispatched', vehicleNo: 'CG 04 MT 1001', tareKg: 9_000, plan: [{ orderLineId: l0.id, plannedKg: 12_000 }], allocations: [{ orderLineId: l0.id, netKg: 11_850 }] },
    t.clock.now(),
  );
  await ownerInsertTruck(
    t.ownerDb,
    { subOrderId: aipAtStart.id, state: 'weighed', vehicleNo: 'CG 04 MT 1002', tareKg: 9_200, plan: [{ orderLineId: l1.id, plannedKg: 10_000 }], allocations: [{ orderLineId: l1.id, netKg: 10_040 }] },
    t.clock.now(),
  );
  // Borai: out of a Siltara plant role's scope.
  const boraiTruck = await ownerInsertTruck(
    t.ownerDb,
    { subOrderId: krmSub.id, state: 'assigned', vehicleNo: 'CG 07 BR 2002', plan: [{ orderLineId: krmSub.lines[0]!.id, plannedKg: 5_000 }] },
    t.clock.now(),
  );
  if (opts.history === true) {
    const aipNow = subOf(await fetchCanvas(), C.AIP);
    await write('POST', `/v1/sub-orders/${aipNow.id}/short-close`, {
      reason: 'Customer stopped lifting',
      note: '',
      cancelOpenTrucks: true,
      version: aipNow.version,
    });
  }
  const canvas = await fetchCanvas();
  const aip = subOf(canvas, C.AIP);
  const draftOf = new Map<string, string>();
  for (const who of [U.rajesh, U.priya, U.amit]) {
    draftOf.set(who, (await created<{ id: string }>(who, '/v1/orders/drafts', { payload: { step: 1 } })).id);
  }
  const draft = (who: string) => draftOf.get(who) ?? draftOf.get(U.rajesh) ?? '';

  // The second tenant: its owner, company and plant, plus a party, a product, an order and a draft.
  const other = await apiFixtures(t.ownerDb, t.clock).createTenant('Elsewhere');
  const otherOwner = await t.ownerDb.$client.query<{ id: string }>('select id from users where tenant_id = $1', [other.tenantId]);
  const otherOwnerId = otherOwner.rows[0]?.id;
  if (otherOwnerId === undefined) throw new Error('world: the second tenant has no owner');
  const otherParty = await ownerInsertParty(t.ownerDb, other.tenantId, otherOwnerId, { type: 'customer', name: 'Elsewhere Buyer' });
  const otherProduct = await ownerInsertProduct(t.ownerDb, other.tenantId, otherOwnerId, [other.companyId]);
  const otherOrder = await ownerInsertOrderLine(t.ownerDb.$client, {
    tenantId: other.tenantId,
    createdBy: otherOwnerId,
    companyId: other.companyId,
    productId: otherProduct,
    at: new Date(t.clock.now()),
  });
  const otherTruck = await ownerInsertTruck(
    t.ownerDb,
    { subOrderId: otherOrder.subOrderId, state: 'assigned', vehicleNo: 'XX 01 ZZ 0001', plan: [] },
    t.clock.now(),
  );
  // A refused arrival on each tenant's truck, for Needs attention (owner only).
  const rejection = async (tenantId: string, truckId: string, userId: string) => {
    const id = uuidv7();
    const event = { eventId: uuidv7(), truckId, deviceSeq: 1, capturedAtDevice: new Date(t.clock.now()).toISOString(), type: 'AT_GATE' };
    await t.ownerDb.$client.query(
      `insert into weighment_rejections (id, tenant_id, client_event_id, truck_id, user_id, device_id, offset_ms, event, code, server_state, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'device-world-0001', 0, $6, 'INVALID_STATE', 'assigned', 'open', $7, $7)`,
      [id, tenantId, event.eventId, truckId, userId, JSON.stringify(event), new Date(t.clock.now())],
    );
    return id;
  };
  const siltaraRejection = await rejection(SAMPLE_WORLD.tenant.id, siltaraTruck, U.ravi);
  const otherRejection = await rejection(other.tenantId, otherTruck, otherOwnerId);
  const otherDraft = uuidv7();
  const at = new Date(t.clock.now());
  await t.ownerDb
    .insert(drafts)
    .values({ id: otherDraft, tenantId: other.tenantId, createdBy: otherOwnerId, payload: { step: 1 }, createdAt: at, updatedAt: at });

  return {
    inScope: (role) => ({
      companies: C.AIP,
      plants: PL.siltara,
      users: U.deepak,
      parties: P.shubham,
      products: PR.tmt12,
      orders: canvas.id,
      drafts: draft(PERSON_FOR[role]),
      'sub-orders': aip.id,
      trucks: siltaraTruck,
      'weighment-rejections': siltaraRejection,
    }),
    otherScope: (role) => {
      if (role === 'owner') return {};
      if (role === 'city_staff') return { drafts: draft(U.amit) };
      return { companies: C.KRM, plants: PL.borai, orders: krm.id, 'sub-orders': krmSub.id, trucks: boraiTruck };
    },
    otherTenant: {
      companies: other.companyId,
      plants: other.plantId,
      users: otherOwnerId,
      parties: otherParty.id,
      products: otherProduct,
      orders: otherOrder.orderId,
      drafts: otherDraft,
      'sub-orders': otherOrder.subOrderId,
      trucks: otherTruck,
      'weighment-rejections': otherRejection,
    },
    bodies: {
      'PATCH /v1/companies/:id': { version: 1 },
      'PATCH /v1/plants/:id': { version: 1 },
      'PATCH /v1/users/:id': { version: 1 },
      'PATCH /v1/parties/:id': partyBody(P.shubham),
      'PATCH /v1/products/:id': productBody(PR.tmt12),
      'PUT /v1/orders/drafts/:id': { payload: { step: 2 }, version: 1 },
      'PATCH /v1/orders/:id': editBody(canvas),
      'POST /v1/sub-orders/:id/short-close': { reason: 'Other', note: '', cancelOpenTrucks: false, version: aip.version },
      'POST /v1/sub-orders/:id/reopen': { version: aip.version },
      'POST /v1/orders/:id/move-quantity': { fromLineId: l0.id, toCompanyId: C.KRM, kg: 1_000, version: canvas.version },
      'DELETE /v1/orders/:id': { confirmNumber: canvas.number },
      'POST /v1/sub-orders/:id/trucks': {
        vehicleNo: 'CG 04 ZZ 9999',
        transporterId: null,
        driverName: 'Driver',
        driverPhone: '9425210877',
        lrNo: '',
        plan: [{ orderLineId: aip.lines[0]!.id, plannedKg: 1_000 }],
      },
      'PATCH /v1/trucks/:id': { lrNo: 'LR-1', version: 1 },
      'POST /v1/trucks/:id/cancel': { reason: 'Other', note: '', version: 1 },
      'POST /v1/trucks/:id/approve': { version: 1 },
      'POST /v1/weighment-rejections/:id/dismiss': { reason: 'Duplicate truck' },
      'POST /v1/orders/:id/vehicle-requests': {
        partyId: P.rkAgarwal,
        contactName: 'R.K. Agarwal',
        number: '+919826100099',
        channel: 'whatsapp',
        lines: [{ orderLineId: aip.lines[0]!.id, kg: 1_000 }],
        totalKg: 1_000,
      },
      'POST /v1/trucks/:id/correct-weight': {
        tareKg: 10_000,
        grossKg: 11_000,
        allocations: [{ orderLineId: aip.lines[0]!.id, netKg: 1_000 }],
        reason: 'Weighbridge recalibrated',
        version: 1,
      },
    },
    call: (role, method, path, body) => send(PERSON_FOR[role], method, path, body),
  };
}

/** The URL with its `:id` replaced by the record of that kind. */
export function pathFor(url: string, ids: Partial<Ids>): string | null {
  const kind = idKindOf(url);
  if (kind === null) return url;
  const id = ids[kind];
  return id === undefined ? null : url.replace(':id', id);
}

/** The order fields the world reads back (the API's `Order`, as far as an edit body needs it). */
interface OrderView {
  id: string;
  number: string;
  version: number;
  type: string;
  customer: { id: string } | null;
  broker: { id: string } | null;
  commissionPerMtSnapshot?: number | null;
  billTo: { id: string } | null;
  shipTo: { id: string } | null;
  pricingMethod: string;
  basicRate?: number | null;
  notify: { customer: boolean; broker: boolean };
  subOrders: {
    id: string;
    companyId: string;
    version: number;
    lines: {
      id: string;
      productId: string;
      length: unknown;
      orderedKg: number;
      rate?: number | null;
      rateEdited: boolean;
      overpricePerMt?: number | null;
    }[];
  }[];
}

/** The order as a `PATCH /v1/orders/:id` body (as the lifecycle contract's `editBody`). */
function editBody(o: OrderView) {
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
      id: s.id,
      companyId: s.companyId,
      lines: s.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        length: l.length,
        orderedKg: l.orderedKg,
        typedRate: o.pricingMethod === 'direct' || l.rateEdited ? (l.rate ?? null) : null,
        overpricePerMt: l.overpricePerMt ?? 0,
      })),
    })),
  };
}

/** A seeded party as an unchanged `PATCH /v1/parties/:id` body. */
function partyBody(id: string) {
  const party = SAMPLE_MASTERS.parties.find((x) => x.id === id);
  if (!party) throw new Error(`world: no sample party ${id}`);
  const { type, name, gstin, city, defaultCommissionPerMt, paymentTermsText, isSelfTransporter, contacts, addresses } = party;
  return { type, name, gstin, city, defaultCommissionPerMt, paymentTermsText, isSelfTransporter, contacts, addresses, version: 1, active: true };
}

/** A seeded product as an unchanged `PATCH /v1/products/:id` body. */
function productBody(id: string) {
  const product = SAMPLE_MASTERS.products.find((x) => x.id === id);
  if (!product) throw new Error(`world: no sample product ${id}`);
  const companyIds = product.companyCodes.map((code) => {
    const company = SAMPLE_WORLD.companies.find((c) => c.code === code);
    if (!company) throw new Error(`world: no company ${code}`);
    return company.id;
  });
  const { category, grade, sizeLabel, conversionPerMt, standardLengths } = product;
  return { category, grade, sizeLabel, conversionPerMt, standardLengths, companyIds, version: 1, active: true };
}
