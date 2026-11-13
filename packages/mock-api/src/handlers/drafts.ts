import { type Draft, draftBodySchema } from '@tonnage/shared';
import { DAY, fromIso, toIso } from '../clock.ts';
import { notFound, stale } from '../errors.ts';
import { route, type RouteDef } from '../router.ts';
import type { DraftRec, MockState } from '../store.ts';
import { type Authed, authed, newId } from '../views.ts';

/** Drafts are purged 7 days after their last save (§5.3). */
export const DRAFT_TTL_MS = 7 * DAY;

function purge(state: MockState, now: number): void {
  state.drafts = state.drafts.filter((d) => now - fromIso(d.updatedAt) <= DRAFT_TTL_MS);
}

/** A draft belongs to its creator; the owner may open anyone's. */
const visible = (a: Authed, d: DraftRec) =>
  d.tenantId === a.user.tenantId && (d.createdBy === a.user.id || a.user.role === 'owner');

function findDraft(state: MockState, a: Authed, id: string | undefined): DraftRec {
  const d = state.drafts.find((x) => x.id === id);
  if (!d || !visible(a, d)) throw notFound();
  return d;
}

export function toDraft(state: MockState, d: DraftRec): Draft {
  return {
    id: d.id,
    payload: structuredCloneJson(d.payload),
    version: d.version,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    createdBy: { id: d.createdBy, name: state.users.find((u) => u.id === d.createdBy)?.name ?? '' },
  };
}

const structuredCloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createDraftRec(
  state: MockState,
  a: Authed,
  payload: Record<string, unknown>,
  now: number,
): DraftRec {
  const at = toIso(now);
  const rec: DraftRec = {
    id: newId(),
    tenantId: a.user.tenantId,
    createdBy: a.user.id,
    payload: structuredCloneJson(payload),
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  state.drafts.push(rec);
  return rec;
}

/** Booking from a draft consumes it; a draft already purged or someone else's is left alone. */
export function deleteDraftIfVisible(state: MockState, a: Authed, id: string): void {
  const i = state.drafts.findIndex((d) => d.id === id && visible(a, d));
  if (i >= 0) state.drafts.splice(i, 1);
}

export const draftRoutes: RouteDef[] = [
  route('GET', '/v1/orders/drafts', {
    action: 'order.create',
    async handler(ctx) {
      const a = authed(ctx);
      purge(ctx.state, ctx.now);
      const list = ctx.state.drafts
        .filter((d) => visible(a, d))
        .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0));
      return { body: list.map((d) => toDraft(ctx.state, d)) };
    },
  }),

  route('POST', '/v1/orders/drafts', {
    action: 'order.create',
    idempotent: true,
    body: draftBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      purge(ctx.state, ctx.now);
      const rec = createDraftRec(ctx.state, a, ctx.body.payload, ctx.now);
      return { status: 201, body: toDraft(ctx.state, rec) };
    },
  }),

  route('GET', '/v1/orders/drafts/:id', {
    action: 'order.create',
    async handler(ctx) {
      const a = authed(ctx);
      purge(ctx.state, ctx.now);
      return { body: toDraft(ctx.state, findDraft(ctx.state, a, ctx.params.id)) };
    },
  }),

  route('PUT', '/v1/orders/drafts/:id', {
    action: 'order.create',
    body: draftBodySchema,
    async handler(ctx) {
      const a = authed(ctx);
      purge(ctx.state, ctx.now);
      const d = findDraft(ctx.state, a, ctx.params.id);
      if (ctx.body.version !== undefined && ctx.body.version !== d.version) throw stale();
      d.payload = structuredCloneJson(ctx.body.payload);
      d.version += 1;
      d.updatedAt = toIso(ctx.now);
      return { body: toDraft(ctx.state, d) };
    },
  }),

  route('DELETE', '/v1/orders/drafts/:id', {
    action: 'order.create',
    async handler(ctx) {
      const a = authed(ctx);
      purge(ctx.state, ctx.now);
      const d = findDraft(ctx.state, a, ctx.params.id);
      ctx.state.drafts.splice(ctx.state.drafts.indexOf(d), 1);
      return { status: 204 };
    },
  }),
];
