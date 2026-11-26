import { agedCutoff, type OrderList, type OrderListQuery, type OrderListStatus, type PlantScope } from '@tonnage/shared';
import { and, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { orders, parties, subOrders } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import { AppError } from '../http/errors.ts';
import type { OrderGraph } from '../views/orderGraph.ts';
import { toOrderSummary } from '../views/orders.ts';
import { anyId, loadOrderGraph, orderViewCtx } from './orderGraph.ts';
import { visibleCompanies } from './org.ts';
import { loadSettings } from './settings.ts';

const emptyCounts = (): Record<OrderListStatus, number> => ({
  all: 0,
  open: 0,
  partly_dispatched: 0,
  completed: 0,
  short_closed: 0,
  cancelled: 0,
});

/** `strpos` rather than LIKE: the needle is literal text, so `%` and `_` need no escaping. */
const contains = (haystack: SQL, needle: string) => sql`strpos(${haystack}, ${needle}) > 0`;

/**
 * The mock's `matches`: the number contains the (trimmed, lower-cased) needle; 3+ digits in it
 * also match the number's digits; or the customer's or broker's name contains it.
 */
function searchFilter(q: string): SQL | undefined {
  const needle = q.trim().toLowerCase();
  if (needle === '') return undefined;
  const digits = needle.replace(/\D/g, '');
  const byDigits =
    digits.length >= 3 ? contains(sql`regexp_replace(${orders.number}, '\\D', '', 'g')`, digits) : sql`false`;
  return sql`(${contains(sql`lower(${orders.number})`, needle)}
    or ${byDigits}
    or exists (select 1 from ${parties}
                where ${parties.tenantId} = ${orders.tenantId}
                  and ${parties.id} in (${orders.customerId}, ${orders.brokerId})
                  and ${contains(sql`lower(${parties.name})`, needle)}))`;
}

interface Cursor {
  at: string;
  id: string;
}

const encodeCursor = (g: OrderGraph) => `${g.order.createdAt.toISOString()}|${g.order.id}`;

/** `createdAt|id`, as the mock writes it; 422 at `cursor` when a part is missing. */
function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const [at, id] = raw.split('|');
  if (!at || !id) throw new AppError(422, 'VALIDATION', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  return { at, id };
}

/** The mock's key order: ISO creation time, then id, compared as strings (a cursor is compared the same way). */
const cmpKey = (o: { createdAt: string; id: string }, c: Cursor): number =>
  o.createdAt === c.at ? (o.id < c.id ? -1 : o.id > c.id ? 1 : 0) : o.createdAt < c.at ? -1 : 1;

/**
 * `GET /v1/orders` (Ruling 4). SQL narrows the candidates: the caller's companies (and the unit
 * filter), the search text and, for `aged=true`, orders old enough to be aged. Their graphs are
 * then summarised by the shared rules exactly as the mock does: the aged flag and status are
 * derived, the counts cover every candidate, and the status filter, sort, cursor and page apply
 * last.
 */
export async function listOrders(
  tx: Tx,
  ctx: { user: AuthedUser; scope: PlantScope; now: number },
  query: OrderListQuery,
): Promise<OrderList> {
  const { user, scope, now } = ctx;
  const visible = (await visibleCompanies(tx, scope)).map((c) => c.id);
  const companyId = query.companyId;
  // In the mock's order: a unit outside the caller's scope is an empty list, before the cursor is read.
  if (companyId !== undefined && !visible.includes(companyId)) {
    return { items: [], counts: emptyCounts(), nextCursor: null };
  }
  const cursor = decodeCursor(query.cursor);
  if (visible.length === 0) return { items: [], counts: emptyCounts(), nextCursor: null };
  const settings = await loadSettings(tx, user.tenantId);
  const agedBefore = new Date(agedCutoff(now, settings.agedOrderDays));
  const candidates = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        sql`exists (select 1 from ${subOrders}
                     where ${subOrders.tenantId} = ${orders.tenantId}
                       and ${subOrders.orderId} = ${orders.id}
                       and ${anyId(subOrders.companyId, companyId === undefined ? visible : [companyId])})`,
        query.q === undefined ? undefined : searchFilter(query.q),
        query.aged === true ? sql`${orders.createdAt} <= ${agedBefore}` : undefined,
      ),
    );
  const graphs = await loadOrderGraph(
    tx,
    candidates.map((c) => c.id),
  );
  const view = await orderViewCtx(tx, user, scope, now, graphs.values());
  const rows = [...graphs.values()]
    .map((g) => ({ g, summary: toOrderSummary(g, view, companyId) }))
    .filter((r) => query.aged === undefined || r.summary.isAged === query.aged);

  const counts = emptyCounts();
  for (const r of rows) {
    counts.all += 1;
    if (r.summary.status !== 'draft') counts[r.summary.status] += 1;
  }
  const dir = query.sort === 'newest' ? -1 : 1;
  const sorted = rows
    .filter((r) => query.status === 'all' || r.summary.status === query.status)
    .sort((x, y) => dir * cmpKey(x.summary, { at: y.summary.createdAt, id: y.summary.id }))
    .filter((r) => cursor === null || dir * cmpKey(r.summary, cursor) > 0);
  const page = sorted.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => r.summary),
    counts,
    nextCursor: sorted.length > page.length && last ? encodeCursor(last.g) : null,
  };
}

