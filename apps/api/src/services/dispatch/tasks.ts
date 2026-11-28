import { type DoneToday, type PlantScope, type TasksPage, type TruckState, istDayStart } from '@tonnage/shared';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.ts';
import { truckTombstones, trucks, weighmentRejections } from '../../db/schema/index.ts';
import type { AuthedUser } from '../../http/auth-hook.ts';
import { boardOrder, sameIstDay, toTask } from '../../views/trucks.ts';
import { readChangeClockForShare } from '../changeClock.ts';
import { anyId } from '../orderGraph.ts';
import { truckViewCtx } from './truckViews.ts';

// Ported from packages/mock-api/src/handlers/supervisor.ts (GET /v1/supervisor/tasks and
// /done-today), with the pull cursor on the tenant change clock (B3 Ruling 3).

const DAY_MS = 24 * 3_600_000;

/**
 * How far back a pull without a cursor reports `resolved` and `deleted`. Such a pull only comes
 * from a fresh device store, which has no outbox rows to settle, so older ones are dead weight.
 */
export const RESOLVED_HORIZON_MS = 30 * DAY_MS;

/** What the phone works on: the truck is not yet weighed (TON-57: weighed belongs to the office). */
const isPhoneTask = (state: TruckState) => state === 'assigned' || state === 'at_gate' || state === 'loading';

/** The caller's plants (every plant for owner and city staff), as a filter on a plant column. */
const inScope = (scope: PlantScope, column: Parameters<typeof anyId>[0]) =>
  scope.kind === 'all' ? undefined : anyId(column, scope.plantIds);

const iso = (d: Date) => d.toISOString();

/**
 * `max(since, clock)`, never moving back. Before the tenant's first change it is the epoch, not the
 * server time: a writer already running may still bump the clock to a time before now.
 */
function nextCursor(since: string | undefined, clock: string | null): string {
  const times = [since, clock ?? undefined].filter((x) => x !== undefined).map((x) => Date.parse(x));
  return iso(new Date(times.length > 0 ? Math.max(...times) : 0));
}

interface PullCtx {
  user: AuthedUser;
  scope: PlantScope;
  now: number;
}

/**
 * `GET /v1/supervisor/tasks`. The change clock is read first, `for share`: that waits for every
 * in-flight writer to commit, so all changes up to it are visible to the reads below. The cursor is
 * `max(since, clock)`; with `>= cursor` (at-least-once) delivery no change falls behind it.
 */
export async function pullTasks(tx: Tx, c: PullCtx, cursor: string | undefined): Promise<TasksPage> {
  const clock = await readChangeClockForShare(tx, c.user.tenantId);
  if (c.scope.kind === 'plants' && c.scope.plantIds.length === 0) {
    return { items: [], removed: [], resolved: [], deleted: [], cursor: nextCursor(cursor, clock), serverTime: iso(new Date(c.now)) };
  }
  const since = cursor === undefined ? null : new Date(cursor);

  // A full pull (no cursor) is a snapshot: the open tasks only, and no tombstones.
  const changed = await tx
    .select({ id: trucks.id, state: trucks.state })
    .from(trucks)
    .where(
      and(
        inScope(c.scope, trucks.plantId),
        since === null ? sql`${trucks.state} in ('assigned', 'at_gate', 'loading')` : gte(trucks.updatedAt, since),
      ),
    );
  const taskIds = changed.filter((t) => isPhoneTask(t.state)).map((t) => t.id);
  const v = await truckViewCtx(tx, c.user, c.scope, c.now, taskIds);
  const items = taskIds
    .map((id) => v.places.get(id)?.truck.truck)
    .filter((t) => t !== undefined)
    .sort(boardOrder)
    .map((t) => toTask(v, t.id));

  const from = since ?? new Date(c.now - RESOLVED_HORIZON_MS);
  const graves = await tx
    .select({ truckId: truckTombstones.truckId, reason: truckTombstones.reason })
    .from(truckTombstones)
    .where(and(inScope(c.scope, truckTombstones.plantId), gte(truckTombstones.removedAt, from)));
  const removed =
    since === null ? [] : [...new Set([...changed.filter((t) => !isPhoneTask(t.state)).map((t) => t.id), ...graves.map((g) => g.truckId)])];
  // My refusals the owner has resolved since (restored or dismissed): the phone stops holding them.
  const settled = await tx
    .select({ clientEventId: weighmentRejections.clientEventId })
    .from(weighmentRejections)
    .where(and(eq(weighmentRejections.userId, c.user.id), isNotNull(weighmentRejections.resolvedAt), gte(weighmentRejections.resolvedAt, from)));
  const resolved = [...new Set(settled.map((r) => r.clientEventId))];
  // Trucks erased with their order: the phone settles every row of theirs still waiting.
  const deleted = [...new Set(graves.filter((g) => g.reason === 'deleted').map((g) => g.truckId))];

  return { items, removed, resolved, deleted, cursor: nextCursor(cursor, clock), serverTime: iso(new Date(c.now)) };
}

/**
 * `GET /v1/supervisor/done-today`. TON-57: what this plant weighed today. `weighedAt` is the gross
 * weighment's business time, so a late sync counts on its own day; each truck then awaits the
 * office or is dispatched.
 */
export async function doneToday(tx: Tx, c: PullCtx): Promise<DoneToday> {
  if (c.scope.kind === 'plants' && c.scope.plantIds.length === 0) return { items: [], totalNetKg: 0 };
  const start = istDayStart(c.now);
  const rows = (
    await tx
      .select()
      .from(trucks)
      .where(
        and(
          inScope(c.scope, trucks.plantId),
          inArray(trucks.state, ['weighed', 'dispatched']),
          gte(trucks.weighedAt, new Date(start)),
          sql`${trucks.weighedAt} < ${new Date(start + DAY_MS).toISOString()}::timestamptz`,
        ),
      )
  )
    .filter((t): t is typeof t & { weighedAt: Date } => t.weighedAt !== null && sameIstDay(t.weighedAt.getTime(), c.now))
    .sort((x, y) => {
      const d = y.weighedAt.getTime() - x.weighedAt.getTime();
      return d !== 0 ? d : x.id < y.id ? -1 : 1;
    });
  const v = await truckViewCtx(
    tx,
    c.user,
    c.scope,
    c.now,
    rows.map((t) => t.id),
  );
  const items: DoneToday['items'] = rows.map((t) => {
    const task = toTask(v, t.id);
    const dispatched = t.state === 'dispatched';
    return {
      truckId: t.id,
      vehicleNo: t.vehicleNo,
      customerName: task.customerName,
      subOrderNumber: task.subOrderNumber,
      netKg: (t.grossKg ?? 0) - (t.tareKg ?? 0),
      status: dispatched ? 'dispatched' : 'awaiting_approval',
      weighedAt: iso(t.weighedAt),
      loadingSlipNo: dispatched ? t.loadingSlipNo : null,
      dispatchedAt: dispatched && t.dispatchedAt !== null ? iso(t.dispatchedAt) : null,
    };
  });
  return { items, totalNetKg: items.reduce((n, x) => n + x.netKg, 0) };
}
