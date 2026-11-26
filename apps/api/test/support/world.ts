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
export type IdKind = 'companies' | 'plants' | 'users' | 'parties' | 'products' | 'orders' | 'drafts' | 'sub-orders';

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
  /** Sends a request as the person playing `role`. */
  call(role: Role, method: HttpMethod, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/**
 * Truncates and seeds (org layer + SAMPLE_MASTERS), then books two orders through the API as the
 * owner (one with a Siltara sub-order carrying a dispatched and a weighed truck, one on Borai only),
 * a draft each for Rajesh, Priya and Amit, and a second tenant with one record of every kind.
 */
export async function buildWorld(t: TestApp): Promise<World> {
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

  type OrderBody = { id: string; subOrders: { id: string; companyId: string; lines: { id: string }[] }[] };
  const canvas = await created<OrderBody>(U.rajesh, '/v1/orders', CANVAS);
  const krm = await created<OrderBody>(U.rajesh, '/v1/orders', KRM_ONLY);
  const aip = canvas.subOrders.find((s) => s.companyId === C.AIP);
  const krmSub = krm.subOrders[0];
  if (!aip || !krmSub) throw new Error('world: the orders lack their sub-orders');
  const [l0, l1] = aip.lines;
  if (!l0 || !l1) throw new Error('world: the AIP sub-order lacks its lines');
  await ownerInsertTruck(
    t.ownerDb,
    { subOrderId: aip.id, state: 'dispatched', vehicleNo: 'CG 04 MT 1001', tareKg: 9_000, plan: [{ orderLineId: l0.id, plannedKg: 12_000 }], allocations: [{ orderLineId: l0.id, netKg: 11_850 }] },
    t.clock.now(),
  );
  await ownerInsertTruck(
    t.ownerDb,
    { subOrderId: aip.id, state: 'weighed', vehicleNo: 'CG 04 MT 1002', tareKg: 9_200, plan: [{ orderLineId: l1.id, plannedKg: 10_000 }], allocations: [{ orderLineId: l1.id, netKg: 10_040 }] },
    t.clock.now(),
  );
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
    }),
    otherScope: (role) => {
      if (role === 'owner') return {};
      if (role === 'city_staff') return { drafts: draft(U.amit) };
      return { companies: C.KRM, plants: PL.borai, orders: krm.id, 'sub-orders': krmSub.id };
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
