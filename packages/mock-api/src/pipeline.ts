import {
  can,
  plantScope,
  redactForRole,
  type PlantScope,
  type TransportRequest,
  type TransportResponse,
} from '@tonnage/shared';
import type { z } from 'zod';
import { DAY, type Clock, fromIso, toIso } from './clock.ts';
import { ApiError, issueDetails, notFound, unauthenticated, validationError } from './errors.ts';
import type { RouteDef, Router } from './router.ts';
import { authenticate } from './sessions.ts';
import type { MockState, Store, UserRec } from './store.ts';

const IDEMPOTENCY_TTL_MS = DAY;

/** JSON round-trip: what a real wire does; also guarantees plain objects for `redactForRole`. */
function wire(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

function parseWith(schema: z.ZodType | undefined, value: unknown): unknown {
  if (!schema) return value;
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(issueDetails(r.error.issues));
  return r.data;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function respond(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): TransportResponse {
  const headers: Record<string, string> = { ...extra };
  if (body !== null && body !== undefined) headers['content-type'] = 'application/json';
  return { status, headers, body: body ?? null };
}

export function errorResponse(e: unknown): TransportResponse {
  const err = e instanceof ApiError ? e : new ApiError(500, 'INTERNAL');
  return respond(err.status, err.toBody());
}

const is2xx = (s: number) => s >= 200 && s < 300;

function purgeIdempotency(state: MockState, userId: string, now: number): void {
  for (const [k, rec] of Object.entries(state.idempotency)) {
    if (k.startsWith(`${userId}:`) && now - fromIso(rec.createdAt) >= IDEMPOTENCY_TTL_MS) {
      delete state.idempotency[k];
    }
  }
}

/**
 * The request pipeline, in the same order as B1's Fastify app (onRequest auth before validation):
 * route match (404) → bearer auth (401) → policy (403) → zod query/body (422) → idempotency
 * → handler (scoped) → money redaction → persist. Unauthenticated callers never see schema errors.
 * Controls (offline/latency/failNext) wrap this in `controls.ts`.
 */
/** Puts every top-level collection back as it was (the state object itself is shared with the store). */
function restore(state: MockState, snapshot: string): void {
  const before = JSON.parse(snapshot) as MockState;
  const target = state as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, before);
}

export function createPipeline(deps: { router: Router; store: Store; clock: Clock }) {
  const { router, store, clock } = deps;

  async function run(req: TransportRequest): Promise<TransportResponse> {
    const now = clock.now();
    const state = store.state;
    const match = router.match(req.method, req.path);
    if (!match) throw notFound();
    const r: RouteDef = match.route;
    const headers = lowerKeys(req.headers);

    let user: UserRec | undefined;
    let scope: PlantScope | undefined;
    if (!r.public) {
      user = authenticate(state, headers.authorization, now) ?? undefined;
      if (!user) throw unauthenticated();
      if (!r.action || !can(user.role, r.action)) throw new ApiError(403, 'FORBIDDEN');
      scope = plantScope(user);
    }

    const query = parseWith(r.query, match.query);
    const body = parseWith(r.body, wire(req.body));

    const routeId = `${r.method} ${r.pattern}`;
    let idemSlot: string | null = null;
    if (r.idempotent && user) {
      const key = headers['idempotency-key'];
      if (!key) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED');
      purgeIdempotency(state, user.id, now);
      idemSlot = `${user.id}:${key}`;
      const stored = state.idempotency[idemSlot];
      if (stored) {
        if (stored.route !== routeId) {
          throw validationError([
            { path: ['idempotency-key'], message: 'This key was already used for another request' },
          ]);
        }
        const replay = redactForRole(user.role, wire(stored.body));
        return respond(stored.status, replay, { 'idempotent-replay': 'true' });
      }
    }

    let result;
    const snapshot = r.transactional ? JSON.stringify(state) : null;
    try {
      result = await r.handler({ user, scope, params: match.params, query, body, state, now });
    } catch (e) {
      if (snapshot !== null) restore(state, snapshot);
      throw e;
    } finally {
      // Handlers may change state even when refusing (OTP failures, refresh-reuse revocation).
      if (req.method !== 'GET') store.schedulePersist();
    }
    const status = result.status ?? 200;
    const plain = wire(result.body);
    if (idemSlot && is2xx(status)) {
      state.idempotency[idemSlot] = {
        route: routeId,
        status,
        body: plain ?? null,
        createdAt: toIso(now),
      };
    }
    const out = user ? redactForRole(user.role, plain) : plain;
    return respond(status, out, result.headers);
  }

  return {
    async handle(req: TransportRequest): Promise<TransportResponse> {
      try {
        return await run(req);
      } catch (e) {
        return errorResponse(e);
      }
    },
  };
}
