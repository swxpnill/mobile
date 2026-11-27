import { type SyncBody, type SyncEvent, type SyncResponse, type SyncResult } from '@tonnage/shared';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../../db/client.ts';
import { syncEvents, trucks, weighmentRejections } from '../../db/schema/index.ts';
import type { EventRouteCtx } from '../../http/route.ts';
import { afterRejection } from '../dispatchEffects.ts';
import { type DispatchCtx, decideEvent } from './apply.ts';
import { inPlantScope } from './truckViews.ts';

// Ported from packages/mock-api/src/handlers/supervisor.ts (POST /v1/weighments/sync) and the
// mock's `replayed` / `remember`: each event in its own transaction (§6.4, B3 Ruling 4).

const BLOCKED_MESSAGE = 'Blocked by an earlier rejected weight';

type Rejected = Extract<SyncResult, { status: 'rejected' }>;

/**
 * Device clock offset (server − device) from the phone's `X-Device-Time` at send time; 0 without
 * it or when it is not a date. Event times on the phone are never trusted on their own.
 */
export function deviceOffsetMs(headers: Record<string, string | undefined>, now: number): number {
  const raw = headers['x-device-time'];
  if (raw === undefined) return 0;
  const device = Date.parse(raw);
  return Number.isFinite(device) ? now - device : 0;
}

/** The answer to an event id seen before, or null: `duplicate` for an accepted event, the same refusal for a rejected one. */
async function replayed(tx: Tx, eventId: string): Promise<SyncResult | null> {
  const [seen] = await tx.select().from(syncEvents).where(eq(syncEvents.clientEventId, eventId));
  if (!seen) return null;
  if (seen.status === 'accepted') return { status: 'duplicate', eventId };
  return { status: 'rejected', eventId, code: seen.code!, message: seen.message ?? '' };
}

/** Another request claimed the same event id first: this transaction rolls back and replays it. */
class ClaimedElsewhere extends Error {}

/** Keeps the outcome (the event's claim): `false` when another transaction already holds the id. */
async function remember(tx: Tx, ctx: DispatchCtx, event: SyncEvent, result: SyncResult): Promise<boolean> {
  if (result.status === 'duplicate') return true;
  const rows = await tx
    .insert(syncEvents)
    .values({
      tenantId: ctx.user.tenantId,
      clientEventId: event.eventId,
      userId: ctx.user.id,
      truckId: event.truckId,
      status: result.status,
      code: result.status === 'rejected' ? result.code : null,
      message: result.status === 'rejected' ? result.message : null,
      createdAt: new Date(ctx.now),
    })
    .onConflictDoNothing()
    .returning({ id: syncEvents.clientEventId });
  return rows.length > 0;
}

/** Keeps a refused event for Needs attention (§6.5), when its truck exists in the caller's tenant. */
async function recordRejection(tx: Tx, ctx: DispatchCtx, event: SyncEvent, r: Rejected): Promise<void> {
  const [truck] = await tx.select({ id: trucks.id, state: trucks.state }).from(trucks).where(eq(trucks.id, event.truckId));
  if (!truck) return; // an id from nowhere: nothing to restore, nothing to show
  const at = new Date(ctx.now);
  const id = uuidv7();
  await tx.insert(weighmentRejections).values({
    id,
    tenantId: ctx.user.tenantId,
    clientEventId: event.eventId,
    truckId: truck.id,
    userId: ctx.user.id,
    deviceId: ctx.deviceId,
    offsetMs: ctx.offsetMs,
    event,
    code: r.code,
    serverState: truck.state,
    status: 'open',
    createdAt: at,
    updatedAt: at,
  });
  await afterRejection(tx, { user: ctx.user, scope: ctx.scope, now: ctx.now }, id);
}

/** One event: its stored answer when seen before, else decided, remembered and (refused) recorded. */
async function oneEvent(tx: Tx, ctx: DispatchCtx, event: SyncEvent, blocked: Set<string>): Promise<SyncResult> {
  const seen = await replayed(tx, event.eventId);
  if (seen) return seen;
  let r: SyncResult;
  if (blocked.has(event.truckId)) {
    // Only a truck the caller may see reports its state (a PLANT_SCOPE truck stays opaque).
    const [truck] = await tx
      .select({ state: trucks.state, plantId: trucks.plantId })
      .from(trucks)
      .where(and(eq(trucks.id, event.truckId)));
    r = {
      status: 'rejected',
      eventId: event.eventId,
      code: 'INVALID_STATE',
      message: BLOCKED_MESSAGE,
      ...(truck && inPlantScope(ctx.scope, truck.plantId) ? { server: { state: truck.state } } : {}),
    };
  } else {
    r = await decideEvent(tx, ctx, event);
  }
  if (!(await remember(tx, ctx, event, r))) throw new ClaimedElsewhere();
  if (r.status === 'rejected') await recordRejection(tx, ctx, event, r);
  return r;
}

/** `POST /v1/weighments/sync`: the events in body order, each committed (or rolled back) on its own. */
export async function syncWeighments(ctx: EventRouteCtx<SyncBody, Record<string, string>>): Promise<SyncResponse> {
  const d: DispatchCtx = {
    user: ctx.user,
    scope: ctx.scope,
    deviceId: ctx.body.deviceId,
    now: ctx.now,
    offsetMs: deviceOffsetMs(ctx.headers, ctx.now),
  };
  // Trucks with a rejected event earlier in this request: their later events wait for the owner.
  const blocked = new Set<string>();
  const results: SyncResult[] = [];
  for (const event of ctx.body.events) {
    let r: SyncResult;
    try {
      r = await ctx.inOwnTransaction((tx) => oneEvent(tx, d, event, blocked));
    } catch (e) {
      if (!(e instanceof ClaimedElsewhere)) throw e;
      // Another request applied this event meanwhile: its answer, as a replay.
      r = (await ctx.inOwnTransaction((tx) => replayed(tx, event.eventId))) ?? { status: 'duplicate', eventId: event.eventId };
    }
    if (r.status === 'rejected') blocked.add(event.truckId);
    results.push(r);
  }
  return { results, serverTime: new Date(ctx.now).toISOString() };
}
