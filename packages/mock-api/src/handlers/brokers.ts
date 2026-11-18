import {
  type BrokerDues,
  type BrokerLedger,
  type BrokerStatement,
  type LedgerBroker,
  type PaymentResult,
  brokerDue,
  brokerStatementQuerySchema,
  checkRange,
  istDateOf,
  ledgerQuerySchema,
  paymentAmount,
  recordPaymentBodySchema,
  reverseEntryBodySchema,
  statementTotals,
} from '@tonnage/shared';
import { toIso } from '../clock.ts';
import { ApiError, notFound, validationError } from '../errors.ts';
import { brokerSummary, entryDateOf, ledgerRows, toLedgerEntry } from '../ledger-views.ts';
import { route, type RouteDef } from '../router.ts';
import type { BrokerLedgerRec, MockState, PartyRec } from '../store.ts';
import { type Authed, authed, logActivity, newId } from '../views.ts';

/** A broker party of the caller's tenant; anything else (a customer, another tenant, no such id) is 404. */
function findBroker(state: MockState, a: Authed, id: string | undefined): PartyRec {
  const p = state.parties.find((x) => x.id === id && x.tenantId === a.user.tenantId && x.type === 'broker');
  if (!p) throw notFound();
  return p;
}

const toBroker = (p: PartyRec): LedgerBroker => ({
  id: p.id,
  name: p.name,
  city: p.city,
  defaultCommissionPerMt: p.defaultCommissionPerMt,
  active: p.active,
});

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

interface Keyed {
  rec: BrokerLedgerRec;
  entryDate: string;
}

/** Newest first: entry date, then creation time, then id, all descending. */
function newestFirst(x: Keyed, y: Keyed): number {
  return cmp(y.entryDate, x.entryDate) || cmp(y.rec.createdAt, x.rec.createdAt) || cmp(y.rec.id, x.rec.id);
}

const encodeCursor = (k: Keyed): string => `${k.entryDate}~${k.rec.createdAt}~${k.rec.id}`;

function decodeCursor(s: string): Keyed {
  const [entryDate, createdAt, id, ...rest] = s.split('~');
  if (!entryDate || !createdAt || !id || rest.length > 0) {
    throw validationError([{ path: ['before'], message: 'Not a valid cursor' }]);
  }
  return { entryDate, rec: { id, createdAt } as BrokerLedgerRec };
}

/** Whether a row is on the earnings side (an earning, or the reversal of one). */
function isEarningSide(state: MockState, r: BrokerLedgerRec): boolean {
  if (r.kind === 'earning') return true;
  if (r.kind === 'payment') return false;
  const target = state.brokerLedger.find((x) => x.id === r.reversesId);
  return target ? target.kind === 'earning' : r.amountRupees <= 0;
}

function assertNotFuture(date: string, today: string, field: string): void {
  if (date > today) throw validationError([{ path: [field], message: 'Date cannot be in the future' }]);
}

export const brokerRoutes: RouteDef[] = [
  route('GET', '/v1/brokers/dues', {
    action: 'money.view',
    async handler(ctx) {
      const a = authed(ctx);
      const { state } = ctx;
      const items = state.parties
        .filter((p) => p.tenantId === a.user.tenantId && p.type === 'broker')
        .map((p) => {
          const own = state.brokerLedger.filter((r) => r.brokerId === p.id);
          return { p, own };
        })
        .filter(({ p, own }) => p.active || own.length > 0)
        .map(({ p, own }) => ({
          brokerId: p.id,
          name: p.name,
          city: p.city,
          active: p.active,
          dueRupees: brokerDue(ledgerRows(state, p.id)),
          lastEntryAt: own.reduce<string | null>((m, r) => (m === null || r.createdAt > m ? r.createdAt : m), null),
        }))
        .sort((x, y) => y.dueRupees - x.dueRupees || cmp(x.name, y.name));
      const totalDueRupees = items.reduce((s, i) => s + Math.max(i.dueRupees, 0), 0);
      return { body: { totalDueRupees, items } satisfies BrokerDues };
    },
  }),

  route('GET', '/v1/brokers/:id/ledger', {
    action: 'money.view',
    query: ledgerQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, query } = ctx;
      const broker = findBroker(state, a, ctx.params.id);
      const cursor = query.before === undefined ? null : decodeCursor(query.before);
      const keyed = state.brokerLedger
        .filter((r) => r.brokerId === broker.id)
        .filter((r) => query.view === 'all' || isEarningSide(state, r) === (query.view === 'earnings'))
        .map((rec) => ({ rec, entryDate: entryDateOf(state, rec) }))
        .sort(newestFirst);
      const rest = cursor === null ? keyed : keyed.filter((k) => newestFirst(cursor, k) < 0);
      const page = rest.slice(0, query.limit);
      const last = page[page.length - 1];
      const body: BrokerLedger = {
        broker: toBroker(broker),
        summary: brokerSummary(state, broker.id, istDateOf(ctx.now)),
        items: page.map((k) => toLedgerEntry(state, k.rec)),
        nextBefore: rest.length > page.length && last ? encodeCursor(last) : null,
      };
      return { body };
    },
  }),

  route('GET', '/v1/brokers/:id/statement', {
    action: 'money.view',
    query: brokerStatementQuerySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, query } = ctx;
      const broker = findBroker(state, a, ctx.params.id);
      const today = istDateOf(ctx.now);
      const range = checkRange(query.from, query.to, today);
      if (range === 'ORDER') throw validationError([{ path: ['to'], message: 'To is before from' }]);
      if (range === 'FUTURE') throw validationError([{ path: ['to'], message: 'Date cannot be in the future' }]);
      if (range === 'TOO_LONG') throw validationError([{ path: ['from'], message: 'The range is too long' }]);
      const rows = ledgerRows(state, broker.id);
      const t = statementTotals(rows, query.from, query.to);
      const inRange = new Set(t.inRange.map((r) => r.id));
      const items = state.brokerLedger
        .filter((r) => inRange.has(r.id))
        .map((rec) => ({ rec, entryDate: entryDateOf(state, rec) }))
        .sort((x, y) => -newestFirst(x, y))
        .map((k) => toLedgerEntry(state, k.rec));
      const tds = items.reduce((s, e) => {
        if (e.kind === 'payment') return s + (e.payment?.tdsRupees ?? 0);
        if (e.kind === 'reversal') {
          const target = state.brokerLedger.find((r) => r.id === e.reversesId);
          return target?.kind === 'payment' ? s - (target.tdsRupees ?? 0) : s;
        }
        return s;
      }, 0);
      const body: BrokerStatement = {
        broker: toBroker(broker),
        from: query.from,
        to: query.to,
        openingDueRupees: t.openingDueRupees,
        earnedRupees: t.earnedRupees,
        paidRupees: t.paidRupees,
        tdsRupees: tds,
        closingDueRupees: t.closingDueRupees,
        items,
      };
      return { body };
    },
  }),

  route('POST', '/v1/brokers/:id/payments', {
    action: 'broker.pay',
    idempotent: true,
    transactional: true,
    body: recordPaymentBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, body } = ctx;
      const broker = findBroker(state, a, ctx.params.id);
      assertNotFuture(body.paidOn, istDateOf(now), 'paidOn');
      const rec: BrokerLedgerRec = {
        id: newId(),
        tenantId: broker.tenantId,
        brokerId: broker.id,
        kind: 'payment',
        truckId: null,
        amountRupees: paymentAmount(body.paidRupees, body.tdsRupees),
        breakdown: [],
        reversesId: null,
        createdAt: toIso(now),
        createdBy: a.user.id,
        mode: body.mode,
        utr: body.utr,
        tdsRupees: body.tdsRupees,
        paidRupees: body.paidRupees,
        paidOn: body.paidOn,
        note: null,
      };
      state.brokerLedger.push(rec);
      logActivity(state, a, now, {
        entityType: 'broker',
        entityId: broker.id,
        action: 'broker.payment_recorded',
        meta: {
          entryId: rec.id,
          mode: body.mode,
          utr: body.utr,
          paidRupees: body.paidRupees,
          tdsRupees: body.tdsRupees,
          paidOn: body.paidOn,
        },
      });
      const result: PaymentResult = {
        entry: toLedgerEntry(state, rec),
        dueRupees: brokerDue(ledgerRows(state, broker.id)),
      };
      return { status: 201, body: result };
    },
  }),

  route('POST', '/v1/ledger/:id/reverse', {
    action: 'broker.pay',
    idempotent: true,
    transactional: true,
    body: reverseEntryBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      const { state, now, body } = ctx;
      const target = state.brokerLedger.find((r) => r.id === ctx.params.id && r.tenantId === a.user.tenantId);
      if (!target) throw notFound();
      if (target.kind !== 'payment') throw new ApiError(409, 'NOT_REVERSIBLE');
      if (state.brokerLedger.some((r) => r.reversesId === target.id)) throw new ApiError(409, 'ALREADY_REVERSED');
      const rec: BrokerLedgerRec = {
        id: newId(),
        tenantId: target.tenantId,
        brokerId: target.brokerId,
        kind: 'reversal',
        truckId: null,
        amountRupees: -target.amountRupees,
        breakdown: [],
        reversesId: target.id,
        createdAt: toIso(now),
        createdBy: a.user.id,
        mode: null,
        utr: null,
        tdsRupees: null,
        paidRupees: null,
        paidOn: null,
        note: body.reason,
      };
      state.brokerLedger.push(rec);
      logActivity(state, a, now, {
        entityType: 'broker',
        entityId: target.brokerId,
        action: 'broker.payment_reversed',
        meta: { entryId: rec.id, reversesId: target.id, reason: body.reason },
      });
      const result: PaymentResult = {
        entry: toLedgerEntry(state, rec),
        dueRupees: brokerDue(ledgerRows(state, target.brokerId)),
      };
      return { status: 201, body: result };
    },
  }),
];
