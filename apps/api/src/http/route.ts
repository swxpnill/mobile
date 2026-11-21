import { can, plantScope, type Action, type HttpMethod, type PlantScope, type Role } from '@tonnage/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { AccessClaims, Tokens } from '../auth/tokens.ts';
import type { Clock } from '../clock.ts';
import { withTenant, type Db, type Tx } from '../db/client.ts';
import { bearerClaims, loadAuthedUser, type AuthedUser } from './auth-hook.ts';
import { badBodyReason } from './body-parser.ts';
import { AppError, issueDetails } from './errors.ts';
import { claimKey, storeResult } from './idempotency.ts';
import { redactBody, toWire } from './redact.ts';

export type { AuthedUser } from './auth-hook.ts';

export interface RouteResult {
  status?: number;
  body?: unknown;
}

export interface RouteCtx<B, Q> {
  user: AuthedUser;
  scope: PlantScope;
  tx: Tx;
  params: Record<string, string>;
  query: Q;
  body: B;
  /** Request time from the injected clock. */
  now: number;
  log: FastifyBaseLogger;
}

/** Public routes run outside any request transaction (auth commits its refusals, Ruling 5). */
export interface PublicRouteCtx<B, Q> {
  db: Db;
  params: Record<string, string>;
  query: Q;
  body: B;
  now: number;
  log: FastifyBaseLogger;
}

interface CommonConfig<B, Q> {
  body?: ZodType<B>;
  query?: ZodType<Q>;
  /** Response schemas by status, serialized (and checked) by Fastify. */
  response?: Record<number, ZodType>;
}

export interface PublicRouteConfig<B, Q> extends CommonConfig<B, Q> {
  public: true;
  action?: never;
  idempotent?: never;
  handler(ctx: PublicRouteCtx<B, Q>): Promise<RouteResult>;
}

export interface AuthedRouteConfig<B, Q> extends CommonConfig<B, Q> {
  public?: never;
  action: Action;
  idempotent?: true;
  handler(ctx: RouteCtx<B, Q>): Promise<RouteResult>;
}

export interface RouteTableEntry {
  method: HttpMethod;
  url: string;
  public?: true;
  action?: Action;
  idempotent?: true;
}

/** What every route needs from the app, plus the table of what `defineRoute` registered. */
export interface PipelineDeps {
  db: Db;
  clock: Clock;
  tokens: Tokens;
}

interface Pipeline extends PipelineDeps {
  routes: RouteTableEntry[];
}

/** Set by the bearer check (onRequest) on routes that need a user; null on public routes. */
export interface RequestAuth {
  claims: AccessClaims;
  now: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    pipeline: Pipeline;
  }
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}

/** Decorates the root app; call before registering any route plugin. */
export function registerPipeline(app: FastifyInstance, deps: PipelineDeps): void {
  app.decorate('pipeline', { ...deps, routes: [] });
  app.decorateRequest('auth', null);
}

/** What `defineRoute` registered on this app (child plugins share the root's table). */
export function routeTable(app: FastifyInstance): RouteTableEntry[] {
  return app.pipeline.routes.map((r) => ({ ...r }));
}

const is2xx = (s: number) => s >= 200 && s < 300;

function parseWith<T>(schema: ZodType<T> | undefined, value: unknown): T {
  const bad = badBodyReason(value);
  if (bad !== null) throw new AppError(422, 'VALIDATION', [{ path: [], message: bad }]);
  if (!schema) return value as T;
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError(422, 'VALIDATION', issueDetails(r.error.issues));
  return r.data;
}

/** Fastify parses `?a=1&a=2` into an array; the contract (and the mock) take the last value. */
function lastValues(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((query ?? {}) as Record<string, string | string[]>)) {
    const last = Array.isArray(v) ? v[v.length - 1] : v;
    if (last !== undefined) out[k] = last;
  }
  return out;
}

/**
 * Throws (a 500, and the request transaction rolls back) when a body does not match its response
 * schema. Fastify checks it again when it serializes, but only after the commit: checking here means
 * a broken body never comes with a committed write, nor with a stored result replayed for 24 h.
 */
function assertResponseShape(
  name: string,
  schemas: Record<number, ZodType> | undefined,
  status: number,
  views: readonly unknown[],
): void {
  const schema = schemas?.[status];
  if (!schema) return;
  for (const view of views) {
    const r = schema.safeParse(view ?? null);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.map(String).join('.') || '(root)').join(', ');
      throw new Error(`Response of ${name} (${status}) does not match its schema at: ${paths}`);
    }
  }
}

const paramsOf = (req: FastifyRequest) => (req.params ?? {}) as Record<string, string>;

/** A non-2xx result: thrown inside the transaction so it rolls back, then sent as returned. */
class NonSuccess {
  constructor(readonly sent: Sent) {}
}

/** What the handler (or a replay) answered, and for whom: redaction needs the caller's current role. */
interface Sent {
  role: Role;
  status: number;
  body: unknown;
  replay: boolean;
}

/**
 * Registers a route with the pipeline (Ruling 10): route match (404, Fastify) → bearer auth (401)
 * → user load and policy (403) → zod query/body (422) → idempotency → handler, scoped and in one
 * transaction with the idempotency row and activity → money redaction of the body.
 */
export function defineRoute<B = unknown, Q = Record<string, string>>(
  app: FastifyInstance,
  method: HttpMethod,
  url: string,
  config: PublicRouteConfig<B, Q> | AuthedRouteConfig<B, Q>,
): void {
  const fullUrl = `${app.prefix}${url}`;
  const name = `${method} ${fullUrl}`;
  if (!config.public && !config.action) throw new Error(`Route ${name} must declare action or public`);
  if (config.public && config.idempotent) throw new Error(`Route ${name}: public routes cannot be idempotent`);

  const pipeline = app.pipeline;
  const entry: RouteTableEntry = { method, url: fullUrl };
  if (config.public) entry.public = true;
  if (config.action) entry.action = config.action;
  if (config.idempotent) entry.idempotent = true;
  pipeline.routes.push(entry);

  const schema = config.response ? { response: config.response } : undefined;

  if (config.public) {
    const c = config;
    app.route({
      method,
      url,
      ...(schema ? { schema } : {}),
      handler: async (req, reply) => {
        const result = await c.handler({
          db: pipeline.db,
          params: paramsOf(req),
          query: parseWith(c.query, lastValues(req.query)),
          body: parseWith(c.body, req.body),
          now: pipeline.clock.now(),
          log: req.log,
        });
        return reply.code(result.status ?? 200).send(result.body ?? null);
      },
    });
    return;
  }

  const c = config;
  const action = c.action;
  app.route({
    method,
    url,
    ...(schema ? { schema } : {}),
    // Before the body is parsed, so a caller without a valid token never sees a body error.
    onRequest: async (req) => {
      const now = pipeline.clock.now();
      const claims = await bearerClaims(pipeline.tokens, req.headers.authorization, now);
      if (!claims) throw new AppError(401, 'UNAUTHENTICATED');
      req.auth = { claims, now };
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = req.auth;
      if (!auth) throw new AppError(401, 'UNAUTHENTICATED'); // onRequest always sets it
      const { claims, now } = auth;
      const header = req.headers['idempotency-key'];
      const key = typeof header === 'string' ? header : '';
      let sent: Sent;
      try {
        sent = await withTenant(pipeline.db, claims.tenantId, async (tx): Promise<Sent> => {
          const u = await loadAuthedUser(tx, claims);
          if (!u) throw new AppError(401, 'UNAUTHENTICATED');
          const role = u.role;
          if (!can(role, action)) throw new AppError(403, 'FORBIDDEN');
          const query = parseWith(c.query, lastValues(req.query));
          const body = parseWith(c.body, req.body);

          const slot = { tenantId: u.tenantId, userId: u.id, key, route: name };
          if (c.idempotent) {
            if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED');
            const claim = await claimKey(tx, slot, now);
            if (claim.kind === 'replay') {
              assertResponseShape(name, c.response, claim.status, [redactBody(role, claim.body)]);
              return { role, status: claim.status, body: claim.body, replay: true };
            }
          }

          const result = await c.handler({
            user: u,
            scope: plantScope(u),
            tx,
            params: paramsOf(req),
            query,
            body,
            now,
            log: req.log,
          });
          const status = result.status ?? 200;
          const plain = toWire(result.body);
          // What this caller is sent, and the full body that is stored and replayed to other roles.
          const sentView = redactBody(role, plain);
          assertResponseShape(name, c.response, status, sentView === plain ? [plain] : [sentView, plain]);
          if (!is2xx(status)) throw new NonSuccess({ role, status, body: plain, replay: false });
          if (c.idempotent) await storeResult(tx, slot, status, plain, now);
          return { role, status, body: plain, replay: false };
        });
      } catch (e) {
        if (!(e instanceof NonSuccess)) throw e;
        sent = e.sent;
      }
      if (sent.replay) reply.header('idempotent-replay', 'true');
      return reply.code(sent.status).send(redactBody(sent.role, sent.body) ?? null);
    },
  });
}
