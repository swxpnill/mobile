import {
  type Party,
  type PartyBody,
  type PartySummary,
  financialYear,
  isTerminal,
  partyBodySchema,
  partyListQuerySchema,
  updatePartyBodySchema,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, notFound, stale, validationError } from '../errors.ts';
import { orderMath, type OrderMath } from '../orders-math.ts';
import { route, type RouteDef } from '../router.ts';
import type { MockState, PartyRec } from '../store.ts';
import { type Authed, authed, logActivity, newId } from '../views.ts';

const digits = (s: string) => s.replace(/\D/g, '');

/** Case-insensitive match on name, city, GSTIN and contact names; 3+ digits also match numbers. */
export function partyMatches(p: PartyRec, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  const text = [p.name, p.city, p.gstin ?? '', ...p.contacts.map((c) => c.name)].join('\n').toLowerCase();
  if (text.includes(needle)) return true;
  const d = digits(needle);
  return d.length >= 3 && p.contacts.some((c) => c.numbers.some((n) => digits(n.number).includes(d)));
}

interface PartyStats {
  openOrders: number;
  pendingKg: number;
  fyDispatchedKg: number;
}

/** Per-party order figures in one pass: open orders and pending (customer or broker side). */
function statsFor(state: MockState, tenantId: string, math: OrderMath, now: number): Map<string, PartyStats> {
  const fy = financialYear(now);
  const out = new Map<string, PartyStats>();
  const bump = (id: string | null, f: (s: PartyStats) => void) => {
    if (!id) return;
    const s = out.get(id) ?? { openOrders: 0, pendingKg: 0, fyDispatchedKg: 0 };
    f(s);
    out.set(id, s);
  };
  for (const o of state.orders) {
    if (o.tenantId !== tenantId) continue;
    let pendingKg = 0;
    let open = false;
    let fyKg = 0;
    for (const sub of math.subOrdersOf(o.id)) {
      if (!isTerminal(math.subOrderStatus(sub))) {
        open = true;
        pendingKg += math.subOrderTotals(sub).pendingKg;
      }
      for (const t of math.trucksOf(sub.id)) {
        if (t.state === 'dispatched' && t.dispatchedAt && financialYear(t.dispatchedAt) === fy) {
          fyKg += t.allocations.reduce((sum, a) => sum + a.netKg, 0);
        }
      }
    }
    for (const id of new Set([o.customerId, o.brokerId])) {
      bump(id, (s) => {
        if (open) s.openOrders += 1;
        s.pendingKg += pendingKg;
        s.fyDispatchedKg += fyKg;
      });
    }
  }
  return out;
}

const NO_STATS: PartyStats = { openOrders: 0, pendingKg: 0, fyDispatchedKg: 0 };

export function toParty(p: PartyRec, stats: PartyStats = NO_STATS): Party {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    gstin: p.gstin,
    city: p.city,
    defaultCommissionPerMt: p.defaultCommissionPerMt,
    paymentTermsText: p.paymentTermsText,
    isSelfTransporter: p.isSelfTransporter,
    contacts: p.contacts.map((c) => ({ ...c, numbers: c.numbers.map((n) => ({ ...n })) })),
    addresses: p.addresses.map((a) => ({ ...a })),
    active: p.active,
    version: p.version,
    stats: { ...stats },
  };
}

function toSummary(p: PartyRec, stats: PartyStats = NO_STATS): PartySummary {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    city: p.city,
    gstin: p.gstin,
    active: p.active,
    people: p.contacts.length,
    numbers: p.contacts.reduce((n, c) => n + c.numbers.length, 0),
    pendingKg: stats.pendingKg,
    defaultCommissionPerMt: p.defaultCommissionPerMt,
  };
}

export function findParty(state: MockState, a: Authed, id: string | undefined): PartyRec {
  const p = state.parties.find((x) => x.id === id && x.tenantId === a.user.tenantId);
  if (!p) throw notFound();
  return p;
}

function assertGstinFree(state: MockState, tenantId: string, gstin: string | null, exceptId?: string): void {
  if (gstin === null) return;
  const other = state.parties.find((p) => p.tenantId === tenantId && p.gstin === gstin && p.id !== exceptId);
  if (other) throw new ApiError(409, 'GSTIN_EXISTS', { partyId: other.id, name: other.name });
}

/** Keeps ids the client sent back for existing children; mints ids for new ones. */
function withIds<T extends { id?: string | undefined }>(items: T[], known: ReadonlySet<string>): (T & { id: string })[] {
  return items.map((i) => ({ ...i, id: i.id !== undefined && known.has(i.id) ? i.id : newId() }));
}

function children(body: PartyBody, existing?: PartyRec) {
  const knownContacts = new Set(existing?.contacts.map((c) => c.id) ?? []);
  const knownNumbers = new Set(existing?.contacts.flatMap((c) => c.numbers.map((n) => n.id)) ?? []);
  const knownAddresses = new Set(existing?.addresses.map((a) => a.id) ?? []);
  return {
    contacts: withIds(body.contacts, knownContacts).map((c) => ({
      id: c.id,
      name: c.name,
      roleLabel: c.roleLabel,
      numbers: withIds(c.numbers, knownNumbers).map((n) => ({
        id: n.id,
        number: n.number,
        label: n.label,
        whatsapp: n.whatsapp,
      })),
    })),
    addresses: withIds(body.addresses, knownAddresses).map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      address: a.address,
      isDefault: a.isDefault,
    })),
  };
}

export const partyRoutes: RouteDef[] = [
  route('GET', '/v1/parties', {
    action: 'masters.manage',
    query: partyListQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { type, q, active } = ctx.query;
      const list = ctx.state.parties.filter(
        (p) =>
          p.tenantId === a.user.tenantId &&
          (type === undefined || p.type === type) &&
          (active === undefined || p.active === active) &&
          (q === undefined || partyMatches(p, q)),
      );
      const stats = statsFor(ctx.state, a.user.tenantId, orderMath(ctx.state), ctx.now);
      list.sort((x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' }));
      return { body: list.map((p) => toSummary(p, stats.get(p.id))) };
    },
  }),

  route('GET', '/v1/parties/:id', {
    action: 'masters.manage',
    async handler(ctx) {
      const a = authed(ctx);
      const p = findParty(ctx.state, a, ctx.params.id);
      const stats = statsFor(ctx.state, a.user.tenantId, orderMath(ctx.state), ctx.now);
      return { body: toParty(p, stats.get(p.id)) };
    },
  }),

  route('POST', '/v1/parties', {
    action: 'masters.manage',
    idempotent: true,
    body: partyBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      assertGstinFree(state, a.user.tenantId, body.gstin);
      const at = toIso(now);
      const rec: PartyRec = {
        id: newId(),
        tenantId: a.user.tenantId,
        type: body.type,
        name: body.name,
        gstin: body.gstin,
        city: body.city,
        defaultCommissionPerMt: body.defaultCommissionPerMt,
        paymentTermsText: body.paymentTermsText,
        isSelfTransporter: body.isSelfTransporter,
        ...children(body),
        active: true,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      state.parties.push(rec);
      logActivity(state, a, now, { entityType: 'party', entityId: rec.id, action: 'party.created' });
      return { status: 201, body: toParty(rec) };
    },
  }),

  route('PATCH', '/v1/parties/:id', {
    action: 'masters.manage',
    body: updatePartyBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { body, state, now } = ctx;
      const p = findParty(state, a, ctx.params.id);
      if (body.version !== p.version) throw stale();
      if (body.type !== p.type) {
        throw validationError([{ path: ['type'], message: "A party's type can't change" }]);
      }
      assertGstinFree(state, a.user.tenantId, body.gstin, p.id);
      const next = children(body, p);
      const kept = new Set(next.addresses.map((x) => x.id));
      const inUse = p.addresses.find(
        (addr) =>
          !kept.has(addr.id) &&
          state.orders.some((o) => o.billToId === addr.id || o.shipToId === addr.id),
      );
      if (inUse) throw new ApiError(409, 'PARTY_IN_USE', { addressId: inUse.id, label: inUse.label });
      Object.assign(p, {
        name: body.name,
        gstin: body.gstin,
        city: body.city,
        defaultCommissionPerMt: body.defaultCommissionPerMt,
        paymentTermsText: body.paymentTermsText,
        isSelfTransporter: body.isSelfTransporter,
        contacts: next.contacts,
        addresses: next.addresses,
        active: body.active,
        version: p.version + 1,
        updatedAt: toIso(now),
      });
      logActivity(state, a, now, { entityType: 'party', entityId: p.id, action: 'party.updated' });
      const stats = statsFor(state, a.user.tenantId, orderMath(state), now);
      return { body: toParty(p, stats.get(p.id)) };
    },
  }),
];
