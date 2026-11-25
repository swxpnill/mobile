import type { Party, PartySummary, Role } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client.ts';
import { partyRefIssues } from '../src/services/parties.ts';
import {
  bearerFor,
  buildTestApp,
  closeTestApps,
  ownerInsertParty,
  ownerInsertTenant,
  ownerInsertUser,
  TEST_NOW,
  type TestApp,
} from './helpers.ts';
import { waitForLockWaiters } from './support/lockWait.ts';

afterEach(closeTestApps);

let t: TestApp;
let tenantId: string;
let owner: Record<string, string>;
let otherOwner: Record<string, string>;

async function personOf(tenant: string, mobile: string, role: Role): Promise<Record<string, string>> {
  const id = await ownerInsertUser(t.ownerDb, tenant, { mobile, name: `User ${mobile}`, role });
  return bearerFor(t, tenant, id);
}

beforeEach(async () => {
  t = await buildTestApp();
  await t.reset();
  tenantId = await ownerInsertTenant(t.ownerDb, 'Agrawal Group');
  owner = await personOf(tenantId, '9826100012', 'owner');
  const other = await ownerInsertTenant(t.ownerDb, 'Other Group');
  otherOwner = await personOf(other, '9000000001', 'owner');
});

const post = (headers: Record<string, string>, payload: object, key = uuidv7()) =>
  t.app.inject({ method: 'POST', url: '/v1/parties', headers: { ...headers, 'idempotency-key': key }, payload });
const patch = (id: string, headers: Record<string, string>, payload: object) =>
  t.app.inject({ method: 'PATCH', url: `/v1/parties/${id}`, headers, payload });
const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });

/** Two contacts with three numbers between them, one bill-to and two ship-to sites. */
const shubham = {
  type: 'customer',
  name: 'Shubham Traders',
  gstin: '27aakfs1234l1z5',
  city: 'Nagpur',
  defaultCommissionPerMt: null,
  paymentTermsText: '30 days',
  isSelfTransporter: false,
  contacts: [
    {
      name: 'Suresh Jain',
      roleLabel: 'Owner',
      numbers: [
        { number: '98260 12345', label: 'Mobile', whatsapp: true },
        { number: '0712 255 1234', label: 'Office', whatsapp: false },
      ],
    },
    { name: 'Manoj Jain', roleLabel: 'Accounts', numbers: [{ number: '98260 54321', label: '', whatsapp: true }] },
  ],
  addresses: [
    { kind: 'bill_to', label: 'Bill to', address: 'Plot 14, Wardhaman Nagar, Nagpur 440008', isDefault: true },
    { kind: 'ship_to', label: 'Hingna MIDC site', address: 'Gate 3, Hingna Road, Nagpur 440016', isDefault: true },
    { kind: 'ship_to', label: 'Butibori yard', address: 'Plot B-22, Butibori, Nagpur 441122', isDefault: false },
  ],
};

const broker = {
  type: 'broker',
  name: 'Sharma Steel Brokers',
  gstin: '22AABCS1429B1ZB',
  city: 'Raipur',
  defaultCommissionPerMt: 150,
  paymentTermsText: '',
  isSelfTransporter: false,
  contacts: [{ name: 'Vinod Sharma', roleLabel: 'Owner', numbers: [{ number: '98271 55012', label: 'Mobile', whatsapp: true }] }],
  addresses: [],
};

const transporter = {
  type: 'transporter',
  name: 'Own fleet',
  gstin: null,
  city: 'Raipur',
  defaultCommissionPerMt: null,
  paymentTermsText: '',
  isSelfTransporter: true,
  contacts: [],
  addresses: [],
};

async function create(body: object, headers = owner): Promise<Party> {
  const res = await post(headers, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Party>();
}

const countRows = async (sql: string, params: unknown[] = []) =>
  (await t.ownerDb.$client.query<{ n: number }>(sql, params)).rows[0]?.n;

/** The body a client sends back to edit a party: the read model's editable fields and version. */
function editBody(p: Party) {
  const { type, name, gstin, city, defaultCommissionPerMt, paymentTermsText, isSelfTransporter, contacts, addresses } = p;
  const fields = { type, name, gstin, city, defaultCommissionPerMt, paymentTermsText, isSelfTransporter };
  return { ...fields, contacts, addresses, active: p.active, version: p.version };
}

describe('parties', () => {
  it('create with two contacts, three numbers, bill-to and ship-to → GET returns the same graph', async () => {
    const created = await create(shubham);
    expect(created).toEqual({
      id: expect.any(String),
      type: 'customer',
      name: 'Shubham Traders',
      gstin: '27AAKFS1234L1Z5',
      city: 'Nagpur',
      defaultCommissionPerMt: null,
      paymentTermsText: '30 days',
      isSelfTransporter: false,
      contacts: [
        {
          id: expect.any(String),
          name: 'Suresh Jain',
          roleLabel: 'Owner',
          numbers: [
            { id: expect.any(String), number: '+919826012345', label: 'Mobile', whatsapp: true },
            { id: expect.any(String), number: '+917122551234', label: 'Office', whatsapp: false },
          ],
        },
        {
          id: expect.any(String),
          name: 'Manoj Jain',
          roleLabel: 'Accounts',
          numbers: [{ id: expect.any(String), number: '+919826054321', label: '', whatsapp: true }],
        },
      ],
      addresses: shubham.addresses.map((a) => ({ ...a, id: expect.any(String) })),
      active: true,
      version: 1,
      stats: { openOrders: 0, pendingKg: 0, fyDispatchedKg: 0 },
    });
    const read = await get(`/v1/parties/${created.id}`, owner);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(created);
    expect(
      await countRows(`select count(*)::int as n from activity_log where action = 'party.created' and entity_id = $1`, [
        created.id,
      ]),
    ).toBe(1);
    expect(
      await countRows(`select count(*)::int as n from parties where id = $1 and created_by is not null`, [created.id]),
    ).toBe(1);
  });

  it('a transporter: isSelfTransporter round-trips; GET adds the trip figures', async () => {
    const created = await create(transporter);
    expect(created).toMatchObject({ isSelfTransporter: true, stats: { openOrders: 0, pendingKg: 0, fyDispatchedKg: 0 } });
    expect(created.stats).not.toHaveProperty('tripsThisMonth');
    const read = (await get(`/v1/parties/${created.id}`, owner)).json<Party>();
    expect(read.stats).toEqual({
      openOrders: 0,
      pendingKg: 0,
      fyDispatchedKg: 0,
      tripsThisMonth: 0,
      vehiclesSeen: 0,
      recentVehicles: [],
    });
  });

  it('PATCH replacing contacts keeps the ids it was sent and drops the others', async () => {
    const created = await create(shubham);
    const [suresh, manoj] = created.contacts;
    if (!suresh || !manoj) throw new Error('two contacts expected');
    const [mobile] = suresh.numbers;
    if (!mobile) throw new Error('a number expected');
    const [bill, ship1] = created.addresses;
    if (!bill || !ship1) throw new Error('addresses expected');
    const body = {
      ...editBody(created),
      contacts: [
        // Suresh keeps his id and his mobile; his office number is dropped and a new one added.
        { ...suresh, name: 'Suresh K. Jain', numbers: [mobile, { number: '98260 99999', label: 'Home', whatsapp: false }] },
        // Manoj is dropped; a new contact comes in without an id.
        { name: 'Ramesh Jain', roleLabel: 'Site', numbers: [{ number: '98260 11111', label: '', whatsapp: true }] },
      ],
      addresses: [bill, { ...ship1, isDefault: true }],
    };
    const res = await patch(created.id, owner, body);
    expect(res.statusCode, res.body).toBe(200);
    const updated = res.json<Party>();
    expect(updated.version).toBe(2);
    expect(updated.contacts.map((c) => c.name)).toEqual(['Suresh K. Jain', 'Ramesh Jain']);
    expect(updated.contacts[0]?.id).toBe(suresh.id);
    expect(updated.contacts[1]?.id).not.toBe(manoj.id);
    expect(updated.contacts[0]?.numbers.map((n) => n.number)).toEqual(['+919826012345', '+919826099999']);
    expect(updated.contacts[0]?.numbers[0]?.id).toBe(mobile.id);
    expect(updated.addresses.map((a) => a.id)).toEqual([bill.id, ship1.id]);
    expect((await get(`/v1/parties/${created.id}`, owner)).json()).toEqual(updated);
    expect(await countRows(`select count(*)::int as n from party_contacts where id = $1`, [manoj.id])).toBe(0);
    expect(await countRows(`select count(*)::int as n from contact_numbers where party_id = $1`, [created.id])).toBe(3);
    expect(await countRows(`select count(*)::int as n from party_addresses where party_id = $1`, [created.id])).toBe(2);
    expect(
      await countRows(`select count(*)::int as n from activity_log where action = 'party.updated' and entity_id = $1`, [
        created.id,
      ]),
    ).toBe(1);
  });

  it('PATCH: an id that is not one of this party\'s children gets a new id', async () => {
    const a = await create(shubham);
    const b = await create({ ...broker, gstin: null });
    const foreign = a.contacts[0];
    if (!foreign) throw new Error('contact expected');
    const res = await patch(b.id, owner, { ...editBody(b), contacts: [foreign] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Party>().contacts[0]?.id).not.toBe(foreign.id);
    expect((await get(`/v1/parties/${a.id}`, owner)).json<Party>().contacts[0]?.id).toBe(foreign.id);
  });

  it('PATCH: a repeated contact, number or address id → 422 at the repeat, nothing written (never a 500)', async () => {
    const created = await create(shubham);
    const [suresh, manoj] = created.contacts;
    const mobile = suresh?.numbers[0];
    const yard = created.addresses[2];
    if (!suresh || !manoj || !mobile || !yard) throw new Error('graph expected');
    const fresh = [{ number: '98260 00000', label: '', whatsapp: false }];
    const cases: [object, (string | number)[]][] = [
      [{ contacts: [suresh, { ...manoj, id: suresh.id, numbers: fresh }] }, ['contacts', 1, 'id']],
      [{ contacts: [{ ...suresh, numbers: [mobile, mobile] }, manoj] }, ['contacts', 0, 'numbers', 1, 'id']],
      [{ contacts: [suresh, { ...manoj, numbers: [mobile] }] }, ['contacts', 1, 'numbers', 0, 'id']],
      [{ addresses: [...created.addresses, yard] }, ['addresses', 3, 'id']],
    ];
    for (const [change, path] of cases) {
      const res = await patch(created.id, owner, { ...editBody(created), ...change });
      expect(res.statusCode, `${path.join('.')}: ${res.body}`).toBe(422);
      expect(res.json().details).toEqual([{ path, message: 'This id is already used in this party' }]);
    }
    expect((await get(`/v1/parties/${created.id}`, owner)).json()).toEqual(created);
  });

  it('PATCH: stale version → 409 STALE; type cannot change → 422 at type', async () => {
    const created = await create(broker);
    const body = editBody(created);
    expect((await patch(created.id, owner, body)).statusCode).toBe(200);
    expect((await patch(created.id, owner, body)).json()).toMatchObject({ code: 'STALE' });
    const typeChange = await patch(created.id, owner, {
      ...body,
      version: 2,
      type: 'transporter',
      defaultCommissionPerMt: null,
    });
    expect(typeChange.statusCode).toBe(422);
    expect(typeChange.json()).toEqual({
      code: 'VALIDATION',
      message: expect.any(String),
      details: [{ path: ['type'], message: "A party's type can't change" }],
    });
  });

  it('a duplicate GSTIN in the tenant → 409 GSTIN_EXISTS naming the other party; another tenant may reuse it', async () => {
    const first = await create(shubham);
    const dup = await post(owner, { ...broker, name: 'Copy', gstin: '27AAKFS1234L1Z5' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({
      code: 'GSTIN_EXISTS',
      message: expect.any(String),
      details: { partyId: first.id, name: 'Shubham Traders' },
    });
    const other = await create(broker);
    const viaPatch = await patch(other.id, owner, { ...editBody(other), gstin: '27AAKFS1234L1Z5' });
    expect(viaPatch.statusCode).toBe(409);
    expect(viaPatch.json().details).toEqual({ partyId: first.id, name: 'Shubham Traders' });
    // Keeping its own GSTIN is not a clash.
    expect((await patch(first.id, owner, editBody(first))).statusCode).toBe(200);
    expect((await post(otherOwner, shubham)).statusCode).toBe(201);
    expect(await countRows(`select count(*)::int as n from parties where gstin = '27AAKFS1234L1Z5'`)).toBe(2);
  });

  it('a second default bill-to → 422 at addresses.i.isDefault; the database refuses it too', async () => {
    const bill = { kind: 'bill_to', label: 'Bill to', address: 'Raipur', isDefault: true };
    const res = await post(owner, { ...broker, addresses: [bill, { ...bill, label: 'Head office' }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toEqual([
      { path: ['addresses', 1, 'isDefault'], message: 'Only one bill-to address can be the default' },
    ]);
    const created = await create({ ...broker, addresses: [bill] });
    const at = new Date(TEST_NOW).toISOString();
    await expect(
      t.ownerDb.$client.query(
        `insert into party_addresses (id, tenant_id, party_id, position, kind, label, address, is_default, created_at, updated_at)
         values ($1, $2, $3, 1, 'bill_to', 'Second', 'Raipur', true, $4, $4)`,
        [uuidv7(), tenantId, created.id, at],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'party_addresses_default_bill_to_key' });
  });

  it("another tenant's party, a random id or a malformed id → identical 404 (GET and PATCH)", async () => {
    const theirs = await create(broker, otherOwner);
    const missing = await get(`/v1/parties/${uuidv7()}`, owner);
    expect(missing.statusCode).toBe(404);
    for (const res of [
      await get(`/v1/parties/${theirs.id}`, owner),
      await get('/v1/parties/not-a-uuid', owner),
      await patch(theirs.id, owner, editBody(theirs)),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(missing.json());
    }
    expect((await get('/v1/parties', owner)).json()).toEqual([]);
  });

  it('plant head and supervisor → 403 on every parties route', async () => {
    const p = await create(broker);
    for (const role of ['plant_head', 'supervisor'] as const) {
      const h = await personOf(tenantId, role === 'plant_head' ? '9826100018' : '9826100014', role);
      expect((await get('/v1/parties', h)).statusCode).toBe(403);
      expect((await get(`/v1/parties/${p.id}`, h)).statusCode).toBe(403);
      expect((await post(h, broker)).statusCode).toBe(403);
      expect((await patch(p.id, h, editBody(p))).statusCode).toBe(403);
    }
  });

  it('list: sorted by name, filtered by type and active; search by name, GSTIN, contact name or 3+ phone digits', async () => {
    const s = await create(shubham);
    const b = await create(broker);
    await create(transporter);
    await create({ ...broker, name: 'agarwal brokers', gstin: null, contacts: [] });
    const all = (await get('/v1/parties', owner)).json<PartySummary[]>();
    expect(all.map((p) => p.name)).toEqual(['agarwal brokers', 'Own fleet', 'Sharma Steel Brokers', 'Shubham Traders']);
    expect(all.find((p) => p.id === s.id)).toEqual({
      id: s.id,
      type: 'customer',
      name: 'Shubham Traders',
      city: 'Nagpur',
      gstin: '27AAKFS1234L1Z5',
      active: true,
      people: 2,
      numbers: 3,
      pendingKg: 0,
      defaultCommissionPerMt: null,
    });
    const names = async (qs: string) =>
      (await get(`/v1/parties?${qs}`, owner)).json<PartySummary[]>().map((p) => p.name);
    expect(await names('type=broker')).toEqual(['agarwal brokers', 'Sharma Steel Brokers']);
    for (const q of ['98260 12345', '27aakfs', 'suresh', 'SHUBHAM', 'nagpur', '054']) {
      expect(await names(`q=${encodeURIComponent(q)}`), q).toEqual(['Shubham Traders']);
    }
    expect(await names('q=60')).toEqual([]); // two digits never match numbers
    expect(await names(`q=${encodeURIComponent('%')}`)).toEqual([]);
    await patch(b.id, owner, { ...editBody(b), active: false });
    expect(await names('type=broker&active=true')).toEqual(['agarwal brokers']);
    expect(await names('active=false')).toEqual(['Sharma Steel Brokers']);
    expect((await get('/v1/parties?type=nobody', owner)).statusCode).toBe(422);
  });

  it('create is idempotent: a retry with the same key replays the party', async () => {
    const key = uuidv7();
    const a = await post(owner, broker, key);
    const b = await post(owner, broker, key);
    expect(a.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(await countRows(`select count(*)::int as n from parties`)).toBe(1);
  });

  it('Review Focus 5: two concurrent creates with the same GSTIN → one 201 and one 409 GSTIN_EXISTS, never a 500', async () => {
    // Hold the GSTIN's unique-index slot in an uncommitted owner transaction, queue both requests
    // behind it, then roll it back: the two requests race for the slot for real.
    const holder = await t.ownerDb.$client.connect();
    try {
      await holder.query('begin');
      const at = new Date(TEST_NOW).toISOString();
      const ownerId = (await holder.query<{ id: string }>(`select id from users where tenant_id = $1`, [tenantId]))
        .rows[0]?.id;
      await holder.query(
        `insert into parties (id, tenant_id, type, name, gstin, city, default_commission_per_mt, payment_terms_text,
           is_self_transporter, active, version, created_by, created_at, updated_at)
         values ($1, $2, 'broker', 'Holder', '22AABCS1429B1ZB', 'Raipur', null, '', false, true, 1, $3, $4, $4)`,
        [uuidv7(), tenantId, ownerId, at],
      );
      const a = post(owner, broker);
      const b = post(owner, { ...broker, name: 'Sharma Steel Brokers (2)' });
      await waitForLockWaiters(t.ownerDb, 2);
      await holder.query('rollback');
      const results = await Promise.all([a, b]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, 409]);
      const won = results.find((r) => r.statusCode === 201);
      const lost = results.find((r) => r.statusCode === 409);
      expect(lost?.json()).toEqual({
        code: 'GSTIN_EXISTS',
        message: expect.any(String),
        details: { partyId: won?.json<Party>().id, name: won?.json<Party>().name },
      });
      expect(await countRows(`select count(*)::int as n from parties`)).toBe(1);
    } finally {
      await holder.query('rollback'); // a no-op (a warning, not an error) once rolled back above
      holder.release();
    }
  });

  it("partyRefIssues: an order's party references, with the mock's paths and messages", async () => {
    const ownerId = (await t.ownerDb.$client.query<{ id: string }>(`select id from users where tenant_id = $1`, [tenantId]))
      .rows[0]?.id;
    if (!ownerId) throw new Error('owner expected');
    const c = await ownerInsertParty(t.ownerDb, tenantId, ownerId, { type: 'customer', name: 'Gupta Hardware' });
    const b = await ownerInsertParty(t.ownerDb, tenantId, ownerId, { type: 'broker', name: 'R.K. Agarwal' });
    const idle = await ownerInsertParty(t.ownerDb, tenantId, ownerId, { type: 'broker', name: 'Idle', active: false });
    const issues = (refs: Parameters<typeof partyRefIssues>[1]) =>
      withTenant(t.db, tenantId, (tx) => partyRefIssues(tx, refs));
    expect(await issues({ customerId: c.id, brokerId: b.id, billToId: c.billToId, shipToId: c.shipToId })).toEqual([]);
    expect(await issues({ customerId: null, brokerId: b.id, billToId: null, shipToId: null })).toEqual([]);
    expect(await issues({ customerId: b.id, brokerId: idle.id, billToId: c.shipToId, shipToId: null })).toEqual([
      { path: ['customerId'], message: 'Choose an active customer' },
      { path: ['brokerId'], message: 'Choose an active broker' },
    ]);
    expect(await issues({ customerId: 'not-a-uuid', brokerId: c.id, billToId: null, shipToId: null })).toEqual([
      { path: ['customerId'], message: 'Choose an active customer' },
      { path: ['brokerId'], message: 'Choose an active broker' },
    ]);
    expect(await issues({ customerId: c.id, brokerId: null, billToId: c.shipToId, shipToId: c.billToId })).toEqual([
      { path: ['billToId'], message: "Choose one of the customer's bill-to addresses" },
      { path: ['shipToId'], message: "Choose one of the customer's sites" },
    ]);
  });
});
