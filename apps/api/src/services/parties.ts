import type { PartyBody, PartyType, partyListQuerySchema } from '@tonnage/shared';
import { financialYear, istDateParts, isTerminal } from '@tonnage/shared';
import { and, asc, desc, eq, inArray, ne, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../db/client.ts';
import { pgError } from '../db/pg-error.ts';
import { contactNumbers, orders, parties, partyAddresses, partyContacts, trucks } from '../db/schema/index.ts';
import { AppError, type IssueDetail } from '../http/errors.ts';
import {
  NO_STATS,
  type PartyGraph,
  type PartyRow,
  type PartyStats,
  type TransporterTrips,
} from '../views/parties.ts';
import { graphMath, truckNetKg } from '../views/orderGraph.ts';
import { anyId, loadOrderGraph } from './orderGraph.ts';
import { isId } from './org.ts';

/** A party and its children in four sequential queries. Row-level security keeps it to the caller's tenant. */
export async function loadParty(tx: Tx, id: string | undefined): Promise<PartyGraph | null> {
  if (!isId(id)) return null;
  const [party] = await tx.select().from(parties).where(eq(parties.id, id));
  if (!party) return null;
  // One after another: a transaction is one connection, and pg queues (and deprecates) overlapping queries.
  const contacts = await tx
    .select()
    .from(partyContacts)
    .where(and(eq(partyContacts.tenantId, party.tenantId), eq(partyContacts.partyId, id)))
    .orderBy(asc(partyContacts.position));
  const numbers = await tx
    .select()
    .from(contactNumbers)
    .where(and(eq(contactNumbers.tenantId, party.tenantId), eq(contactNumbers.partyId, id)))
    .orderBy(asc(contactNumbers.position));
  const addresses = await tx
    .select()
    .from(partyAddresses)
    .where(and(eq(partyAddresses.tenantId, party.tenantId), eq(partyAddresses.partyId, id)))
    .orderBy(asc(partyAddresses.position));
  return {
    party,
    contacts: contacts.map((c) => ({ ...c, numbers: numbers.filter((n) => n.contactId === c.id) })),
    addresses,
  };
}

/** The party graph, or 404 (the same for another tenant's, a random or a malformed id). */
export async function findParty(tx: Tx, id: string | undefined): Promise<PartyGraph> {
  const g = await loadParty(tx, id);
  if (!g) throw new AppError(404, 'NOT_FOUND');
  return g;
}

export interface PartyRefs {
  customerId: string | null;
  brokerId: string | null;
  billToId: string | null;
  shipToId: string | null;
}

/** What an order needs to know about a referenced party. */
interface PartyRef {
  type: PartyType;
  active: boolean;
  addresses: { id: string; kind: 'bill_to' | 'ship_to' }[];
}

/** The referenced parties in one query: type, active and their addresses (ids not uuids never match). */
async function partyRefs(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, PartyRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null && isId(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      id: parties.id,
      type: parties.type,
      active: parties.active,
      addressId: partyAddresses.id,
      kind: partyAddresses.kind,
    })
    .from(parties)
    .leftJoin(
      partyAddresses,
      and(eq(partyAddresses.tenantId, parties.tenantId), eq(partyAddresses.partyId, parties.id)),
    )
    .where(inArray(parties.id, wanted));
  const out = new Map<string, PartyRef>();
  for (const r of rows) {
    const ref = out.get(r.id) ?? { type: r.type, active: r.active, addresses: [] };
    if (r.addressId !== null && r.kind !== null) ref.addresses.push({ id: r.addressId, kind: r.kind });
    out.set(r.id, ref);
  }
  return out;
}

/**
 * What an order points at on the party side, as the mock's `validateOrderRefs` checks it: parties of
 * the right type and active, addresses belonging to the customer. Returns the issues (the caller
 * collects them with its own before throwing 422).
 */
export async function partyRefIssues(tx: Tx, refs: PartyRefs): Promise<IssueDetail[]> {
  const issues: IssueDetail[] = [];
  const found = await partyRefs(tx, [refs.customerId, refs.brokerId]);
  const party = (id: string | null, type: Extract<PartyType, 'customer' | 'broker'>, path: string) => {
    if (id === null) return null;
    const p = found.get(id);
    if (!p || p.type !== type || !p.active) {
      issues.push({ path: [path], message: `Choose an active ${type}` });
      return null;
    }
    return p;
  };
  const customer = party(refs.customerId, 'customer', 'customerId');
  party(refs.brokerId, 'broker', 'brokerId');
  if (customer) {
    const has = (id: string | null, kind: 'bill_to' | 'ship_to') =>
      id === null || customer.addresses.some((x) => x.id === id && x.kind === kind);
    if (!has(refs.billToId, 'bill_to')) {
      issues.push({ path: ['billToId'], message: "Choose one of the customer's bill-to addresses" });
    }
    if (!has(refs.shipToId, 'ship_to')) {
      issues.push({ path: ['shipToId'], message: "Choose one of the customer's sites" });
    }
  }
  return issues;
}

/** `partyRefIssues`, thrown as 422 VALIDATION when there are any. */
export async function assertPartyRefs(tx: Tx, refs: PartyRefs): Promise<void> {
  const issues = await partyRefIssues(tx, refs);
  if (issues.length > 0) throw new AppError(422, 'VALIDATION', issues);
}

/**
 * Per-party order figures, as the mock's `statsFor`: for each order the party is on (customer or
 * broker side), whether it has a sub-order still open, its pending kg on open sub-orders, and the
 * net kg of its trucks dispatched in the current IST financial year. Every sub-order counts
 * (masters are an office screen). Loaded through the order graph: two queries plus its six.
 */
export async function partyStats(
  tx: Tx,
  partyIds: readonly string[],
  now: number,
): Promise<Map<string, PartyStats>> {
  const wanted = new Set(partyIds.filter(isId));
  const out = new Map<string, PartyStats>();
  if (wanted.size === 0) return out;
  const ids = [...wanted];
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(or(anyId(orders.customerId, ids), anyId(orders.brokerId, ids)));
  const graphs = await loadOrderGraph(
    tx,
    rows.map((r) => r.id),
  );
  const fy = financialYear(now);
  for (const g of graphs.values()) {
    const m = graphMath(g);
    let pendingKg = 0;
    let open = false;
    let fyKg = 0;
    for (const s of g.subOrders) {
      if (!isTerminal(m.subOrderStatus(s))) {
        open = true;
        pendingKg += m.subOrderTotals(s).pendingKg;
      }
      for (const t of s.trucks) {
        const at = t.truck.dispatchedAt;
        if (t.truck.state === 'dispatched' && at !== null && financialYear(at.getTime()) === fy) fyKg += truckNetKg(t);
      }
    }
    for (const id of new Set([g.order.customerId, g.order.brokerId])) {
      if (id === null || !wanted.has(id)) continue;
      const st = out.get(id) ?? { ...NO_STATS };
      if (open) st.openOrders += 1;
      st.pendingKg += pendingKg;
      st.fyDispatchedKg += fyKg;
      out.set(id, st);
    }
  }
  return out;
}

/** The mock's `vehicleKey`: one vehicle however its number is spaced or cased. */
const vehicleKey = (vehicleNo: string): string => vehicleNo.replace(/\s+/g, '').toLowerCase();

/**
 * A transporter's figures (GET and PATCH only, as in the mock): its trucks (not cancelled)
 * dispatched this IST month, distinct vehicles seen, and the latest five, newest assignment first.
 */
export async function transporterTrips(tx: Tx, p: PartyRow, now: number): Promise<TransporterTrips | undefined> {
  if (p.type !== 'transporter') return undefined;
  const rows = await tx
    .select({ vehicleNo: trucks.vehicleNo, state: trucks.state, dispatchedAt: trucks.dispatchedAt })
    .from(trucks)
    .where(and(eq(trucks.transporterId, p.id), ne(trucks.state, 'cancelled')))
    .orderBy(desc(trucks.assignedAt), desc(trucks.id));
  const month = istDateParts(now);
  const tripsThisMonth = rows.filter((t) => {
    if (t.state !== 'dispatched' || t.dispatchedAt === null) return false;
    const d = istDateParts(t.dispatchedAt.getTime());
    return d.year === month.year && d.month === month.month;
  }).length;
  const vehicles = new Map<string, string>();
  for (const t of rows) {
    if (!vehicles.has(vehicleKey(t.vehicleNo))) vehicles.set(vehicleKey(t.vehicleNo), t.vehicleNo);
  }
  return { tripsThisMonth, vehiclesSeen: vehicles.size, recentVehicles: [...vehicles.values()].slice(0, 5) };
}

/** The foreign keys from orders to the addresses they bill and ship to (never cascade). */
export const ORDER_ADDRESS_FKS: ReadonlySet<string> = new Set(['orders_bill_to_fk', 'orders_ship_to_fk']);

/**
 * The first of these addresses (in the order given, as the mock finds it) that an order bills or
 * ships to, or null. A PATCH that drops it is the mock's 409 PARTY_IN_USE.
 */
export async function addressInUse(
  tx: Tx,
  addresses: readonly { id: string; label: string }[],
): Promise<{ addressId: string; label: string } | null> {
  if (addresses.length === 0) return null;
  const ids = addresses.map((a) => a.id);
  const rows = await tx
    .select({ billToId: orders.billToId, shipToId: orders.shipToId })
    .from(orders)
    .where(or(anyId(orders.billToId, ids), anyId(orders.shipToId, ids)));
  const used = new Set(rows.flatMap((r) => [r.billToId, r.shipToId]));
  const hit = addresses.find((a) => used.has(a.id));
  return hit ? { addressId: hit.id, label: hit.label } : null;
}

/**
 * Runs a party PATCH and turns an address delete refused by an order's foreign key (an order booked
 * on it after `assertAddressesFree` looked) into the same 409 PARTY_IN_USE, naming the address.
 */
export async function withAddressGuard<T>(
  tx: Tx,
  existing: PartyGraph,
  body: Pick<PartyBody, 'addresses'>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code !== '23503' || pg.constraint === undefined || !ORDER_ADDRESS_FKS.has(pg.constraint)) throw e;
    // The write ran in a savepoint, so the transaction can still look the order up.
    await assertAddressesFree(tx, existing, body);
    throw e;
  }
}

/** 409 PARTY_IN_USE when an order uses one of the addresses the body leaves out. */
export async function assertAddressesFree(
  tx: Tx,
  existing: PartyGraph,
  body: Pick<PartyBody, 'addresses'>,
): Promise<void> {
  const kept = new Set(body.addresses.map((a) => a.id));
  const used = await addressInUse(
    tx,
    existing.addresses.filter((a) => !kept.has(a.id)),
  );
  if (used) throw new AppError(409, 'PARTY_IN_USE', used);
}

export const statsOf = (stats: Map<string, PartyStats>, id: string): PartyStats => stats.get(id) ?? NO_STATS;

/**
 * A correlated subquery's link to the outer `parties` row. Written table-qualified on purpose: drizzle
 * leaves columns unqualified in a one-table select, and inside the subquery `"id"` would bind to the
 * child's own id.
 */
const ofOuterParty = (child: 'party_contacts' | 'contact_numbers') =>
  sql.raw(`"${child}"."tenant_id" = "parties"."tenant_id" and "${child}"."party_id" = "parties"."id"`);

/** `strpos` rather than LIKE: the needle is literal text, so `%` and `_` need no escaping. */
const containsText = (column: SQLWrapper, needle: string) =>
  sql`strpos(lower(${column}), ${needle}) > 0`;

/**
 * The mock's `partyMatches`: case-insensitive match on name, city, GSTIN and contact names; a needle
 * with 3+ digits also matches the digits of any number.
 */
function searchFilter(q: string): SQL | undefined {
  const needle = q.trim().toLowerCase();
  if (needle === '') return undefined;
  const digits = needle.replace(/\D/g, '');
  const byText = sql`(${containsText(parties.name, needle)}
    or ${containsText(parties.city, needle)}
    or ${containsText(sql`coalesce(${parties.gstin}, '')`, needle)}
    or exists (select 1 from ${partyContacts}
                where ${ofOuterParty('party_contacts')}
                  and strpos(lower(${partyContacts.name}), ${needle}) > 0))`;
  if (digits.length < 3) return byText;
  return sql`(${byText} or exists (select 1 from ${contactNumbers}
      where ${ofOuterParty('contact_numbers')}
        and strpos(regexp_replace(${contactNumbers.number}, '\\D', '', 'g'), ${digits}) > 0))`;
}

export interface PartyListRow {
  party: PartyRow;
  people: number;
  numbers: number;
}

/** The list, sorted by name as the mock sorts it (`localeCompare`, base sensitivity, stable). */
export async function listParties(tx: Tx, query: z.output<typeof partyListQuerySchema>): Promise<PartyListRow[]> {
  const rows = await tx
    .select({
      party: parties,
      people: sql<number>`(select count(*)::int from ${partyContacts}
        where ${ofOuterParty('party_contacts')})`,
      numbers: sql<number>`(select count(*)::int from ${contactNumbers}
        where ${ofOuterParty('contact_numbers')})`,
    })
    .from(parties)
    .where(
      and(
        query.type === undefined ? undefined : eq(parties.type, query.type),
        query.active === undefined ? undefined : eq(parties.active, query.active),
        query.q === undefined ? undefined : searchFilter(query.q),
      ),
    )
    .orderBy(asc(parties.createdAt), asc(parties.id));
  return rows.sort((x, y) => x.party.name.localeCompare(y.party.name, 'en', { sensitivity: 'base' }));
}

type Children = Pick<PartyBody, 'contacts' | 'addresses'>;

/** Keeps ids the client sent back for this party's existing children; mints ids for the rest (as the mock). */
function withIds<T extends { id?: string | undefined }>(items: T[], known: ReadonlySet<string>): (T & { id: string })[] {
  return items.map((i) => ({ ...i, id: i.id !== undefined && known.has(i.id) ? i.id : uuidv7() }));
}

/** The body's children as rows, with ids resolved against the party's current children (if any). */
function childRows(tenantId: string, partyId: string, body: Children, at: Date, existing?: PartyGraph) {
  const knownContacts = new Set(existing?.contacts.map((c) => c.id) ?? []);
  const knownNumbers = new Set(existing?.contacts.flatMap((c) => c.numbers.map((n) => n.id)) ?? []);
  const knownAddresses = new Set(existing?.addresses.map((a) => a.id) ?? []);
  const stamps = { createdAt: at, updatedAt: at };
  const contacts = withIds(body.contacts, knownContacts);
  return {
    contacts: contacts.map((c, position) => ({
      id: c.id,
      tenantId,
      partyId,
      position,
      name: c.name,
      roleLabel: c.roleLabel,
      ...stamps,
    })),
    numbers: contacts.flatMap((c) =>
      withIds(c.numbers, knownNumbers).map((n, position) => ({
        id: n.id,
        tenantId,
        partyId,
        contactId: c.id,
        position,
        number: n.number,
        label: n.label,
        whatsapp: n.whatsapp,
        ...stamps,
      })),
    ),
    addresses: withIds(body.addresses, knownAddresses).map((a, position) => ({
      id: a.id,
      tenantId,
      partyId,
      position,
      kind: a.kind,
      label: a.label,
      address: a.address,
      isDefault: a.isDefault,
      ...stamps,
    })),
  };
}

const excluded = (column: string) => sql.raw(`excluded.${column}`);

/**
 * Writes a party's children from the body (Ruling 7: the arrays are replaced, keeping ids the body
 * sends back). Children no longer listed are deleted; the rest are upserted by id, so a kept address
 * is updated in place (orders will reference addresses, so they are never deleted and reinserted).
 */
export async function saveChildren(
  tx: Tx,
  party: PartyRow,
  body: Children,
  at: Date,
  existing?: PartyGraph,
): Promise<void> {
  const rows = childRows(party.tenantId, party.id, body, at, existing);
  if (existing) {
    const ofParty = <T extends typeof partyContacts | typeof contactNumbers | typeof partyAddresses>(t: T) =>
      and(eq(t.tenantId, party.tenantId), eq(t.partyId, party.id));
    await tx
      .delete(partyContacts)
      .where(and(ofParty(partyContacts), notInArray(partyContacts.id, rows.contacts.map((c) => c.id))));
    await tx
      .delete(contactNumbers)
      .where(and(ofParty(contactNumbers), notInArray(contactNumbers.id, rows.numbers.map((n) => n.id))));
    await tx
      .delete(partyAddresses)
      .where(and(ofParty(partyAddresses), notInArray(partyAddresses.id, rows.addresses.map((a) => a.id))));
    // The default bill-to may move between two kept rows; the unique index is checked row by row,
    // so clear the flags first and let the upsert set the one the body marks.
    await tx.update(partyAddresses).set({ isDefault: false }).where(ofParty(partyAddresses));
  }
  if (rows.contacts.length > 0) {
    await tx
      .insert(partyContacts)
      .values(rows.contacts)
      .onConflictDoUpdate({
        target: partyContacts.id,
        set: { position: excluded('position'), name: excluded('name'), roleLabel: excluded('role_label'), updatedAt: at },
      });
  }
  if (rows.numbers.length > 0) {
    await tx
      .insert(contactNumbers)
      .values(rows.numbers)
      .onConflictDoUpdate({
        target: contactNumbers.id,
        set: {
          contactId: excluded('contact_id'),
          position: excluded('position'),
          number: excluded('number'),
          label: excluded('label'),
          whatsapp: excluded('whatsapp'),
          updatedAt: at,
        },
      });
  }
  if (rows.addresses.length > 0) {
    await tx
      .insert(partyAddresses)
      .values(rows.addresses)
      .onConflictDoUpdate({
        target: partyAddresses.id,
        set: {
          position: excluded('position'),
          kind: excluded('kind'),
          label: excluded('label'),
          address: excluded('address'),
          isDefault: excluded('is_default'),
          updatedAt: at,
        },
      });
  }
}

/** Where the body's second default bill-to is (the shared schema reports it there first). */
function secondDefaultBillTo(body: Pick<PartyBody, 'addresses'>): number {
  let seen = false;
  return body.addresses.findIndex((a) => {
    if (a.kind !== 'bill_to' || !a.isDefault) return false;
    if (seen) return true;
    seen = true;
    return false;
  });
}

/**
 * Runs a party write in a savepoint and maps its unique violations by constraint name:
 * - the tenant's GSTIN → 409 GSTIN_EXISTS naming the other party (as the mock), also when a concurrent
 *   create committed it first: the savepoint keeps the transaction usable to look that party up;
 * - a second default bill-to → 422 VALIDATION at `addresses.i.isDefault` (backstop; zod refuses it first).
 */
export async function withPartyUniqueness<T>(
  tx: Tx,
  body: Pick<PartyBody, 'gstin' | 'addresses'>,
  write: (sp: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await tx.transaction(write);
  } catch (e) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === 'parties_tenant_gstin_key' && body.gstin !== null) {
      const [other] = await tx
        .select({ partyId: parties.id, name: parties.name })
        .from(parties)
        .where(eq(parties.gstin, body.gstin));
      if (other) throw new AppError(409, 'GSTIN_EXISTS', other);
    }
    if (pg?.code === '23505' && pg.constraint === 'party_addresses_default_bill_to_key') {
      throw new AppError(422, 'VALIDATION', [
        {
          path: ['addresses', Math.max(secondDefaultBillTo(body), 0), 'isDefault'],
          message: 'Only one bill-to address can be the default',
        },
      ]);
    }
    throw e;
  }
}
