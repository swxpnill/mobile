# B1 API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-11-21** against `main` after F1–F5 and TON-57 (first written 2026-11-04 alongside F1). The changes are listed under Rulings.

**Goal:** The real API for the M1 contract: Fastify on PostgreSQL, with tenant isolation enforced by composite keys and RLS. It must pass the M1 suites of `packages/contract-tests` that the mock passes, and add the database guarantees the mock cannot give (real concurrency, row locks, RLS).

**Architecture:** `apps/api` is Fastify + Drizzle on node-postgres with two DB roles: the migration owner, and `tonnage_app` at runtime so RLS always applies. Every authenticated request runs in one transaction that first sets `app.tenant_id`. It reuses `packages/shared` unchanged (schemas, `policy.ts`, `redactForRole`, errors, settings, `SAMPLE_WORLD`). Route config (`public` / `action` / `idempotent`) mirrors `packages/mock-api`'s router, and a parity test keeps the two route tables identical for M1.

**Tech Stack:** Node 22, TypeScript, Fastify 5, fastify-type-provider-zod, zod, Drizzle ORM + drizzle-kit, `pg`, jose (HS256 JWT), uuid v7, pino, @fastify/rate-limit, embedded-postgres (local and test: there is no Docker on the dev machine), `postgres:16` service container in CI, Vitest. Use the current major at install time; the lockfile pins exact versions.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md` (§2, §4, §5.5, §5.7, §7, §7.1, §9, §10). **Contract:** `packages/contract-tests`, suites `auth`, `pipeline`, `org`, `users`, `me`, `settings`. **Reference behaviour:** `packages/mock-api/src/{pipeline,sessions,router}.ts` and `handlers/{auth,me,meta,companies,plants,users,settings}.ts`. Where this plan and the mock disagree, the contract suite decides.

## Global Constraints

All Global Constraints of `2026-11-04-f1-app-foundation.md` apply, plus:
- Every tenant-owned table has `tenant_id uuid not null`. Foreign keys between tenant tables are composite: `(tenant_id, x_id)` → `(tenant_id, id)`.
- RLS on every tenant table: `USING` and `WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`. The runtime role `tonnage_app` never owns a table and is not `BYPASSRLS`.
- `app.tenant_id` is set with `set_config(..., true)` (transaction-local) inside the request's transaction, never per session. This stays correct behind a transaction-mode pooler (Neon, PgBouncer).
- IDs are UUIDv7, generated in application code.
- **Time comes from the injected `Clock`, never from Postgres `now()`,** for anything a rule reads: token, OTP and lockout expiry, refresh grace, idempotency retention, `last_seen_at`, `invited_at`, `created_at`/`updated_at` written by handlers. Column defaults may use `now()` only as a fallback.
- The API refuses to boot when `NODE_ENV=production` and `OTP_PROVIDER=dev`.
- OTP code hashes and refresh tokens are stored as SHA-256 hashes and compared with `crypto.timingSafeEqual`. A token or code never appears in a log line.
- Responses match the shared zod schemas exactly (the contract's `parseExact` fails on extra keys). Out-of-scope or other-tenant records are 404, never 403.
- Rate limiting is on outside tests (`RATE_LIMIT=on`, the default) and off for the contract target (the suite sends far more auth requests than a client would).
- Scripts work in Git Bash and PowerShell: no `rm -rf`, no `export X=`. Use `cross-env` only if a script truly needs an env var.

## Rulings (what changed since 2026-11-04, and gaps the first draft left open)

1. **Scope is 22 routes:** `GET /v1/meta`; `POST /v1/auth/{request-code,verify,refresh,sign-out}`; `GET /v1/me`, `PATCH /v1/me/preferences`; `GET|POST /v1/companies`, `GET|PATCH /v1/companies/:id`; `GET|POST /v1/plants`, `GET|PATCH /v1/plants/:id`; `GET|POST /v1/users`, `PATCH /v1/users/:id`, `POST /v1/users/:id/{deactivate,reactivate}`; `GET|PATCH /v1/settings`. The first draft missed `GET /v1/companies/:id` and `GET /v1/plants/:id`, which F1 added. Push-token routes (F5) belong to B4.
2. **The contract suite now holds 17 suites (F1–F5).** `packages/contract-tests` exports `M1_SUITES` (auth, pipeline, org, users, me, settings) and `registerSuites(suites, factory)`. The API runs `M1_SUITES`; each later B milestone appends its suites, until B4 runs `CONTRACT_SUITES`. The mock keeps running everything through `registerAll`.
3. **`ContractFixtures.addTruck`** cannot exist before B3. The API fixture throws `Error('addTruck: available from B3')`, and no M1 suite calls it.
4. **Refresh grace returns the identical pair** (contract: "same old refresh twice within 30 s → identical new pair"). The rotated row keeps its successor pair encrypted (`successor_enc`, AES-256-GCM, key = HKDF-SHA256 of `JWT_SECRET` with info `refresh-successor`). After 30 s a reuse revokes every refresh token of the user, and `successor_enc` is cleared when the row is next touched. Plaintext tokens are never stored.
5. **Refusals must be recorded.** OTP failure counts, lockouts and refresh-reuse revocations commit even though the response is an error. Auth routes are not wrapped in the request transaction: the service writes the refusal in its own statement, then throws. All other writes are all-or-nothing in one transaction, matching the mock's `transactional`.
6. **`request-code`** answers the same `200 { resendAfterSeconds: 30 }` for known and unknown numbers. It upserts the challenge either way (the mock does too; this is what makes resend and lockout behave the same for unknown numbers). The provider sends a code only when an active user has that mobile. Lockout is checked here as well as on verify.
7. **Idempotency matches the mock's pipeline.** The slot is `(user_id, key)`. Only a 2xx is stored: a failed handler deletes its in-progress row, so a retry runs again. A replay is redacted for the caller's current role and carries `idempotent-replay: true`. Retention is 24 h by the `Clock`. The same key on another route gives `422 VALIDATION` at path `['idempotency-key']`.
8. **Company deactivation:** `assertCompanyDeactivatable(tx, companyId)` exists and always resolves in B1. B2 adds the `409 COMPANY_HAS_OPEN_ORDERS` check once sub-orders exist.
9. **Devices:** `verify` upserts `devices(id = deviceId, tenant_id, user_id, last_seen_at)`. `sign-out` revokes the token and clears that device's `push_token`. Registering a push token is B4.
10. **Pipeline order is the mock's:** route match (404) → bearer auth (401) → policy (403) → zod query/body (422) → idempotency → handler (scoped, in a transaction) → money redaction. An unauthenticated caller never sees a schema error.
11. **The app is not changed in B1.** As a manual smoke test, the emulator runs the M1 screens (sign-in, More, Companies, Users, Settings) against the local API with `EXPO_PUBLIC_API_MODE=http`. Other tabs are expected to fail until B2–B4.

## Review Focus

Most likely to bite a real user, and not pinned by the contract suite (the mock serialises requests):
1. **Two refreshes of one token at the same moment** (the foreground sync loop and the background task, or a retry): both must get the identical new pair. Neither may trip reuse detection and sign the person out. → Task 3, `select … for update` on the token row.
2. **Two owners demote or deactivate each other at the same moment:** exactly one succeeds; the other gets `409 LAST_OWNER`. → Task 6, `select … for update` on the tenant's active owners.
3. **Five wrong codes sent in parallel:** the counter still reaches 5 and locks (no lost update), and the right code is refused while locked. → Task 3, row lock on the challenge.
4. **A handler that forgets the tenant transaction** (queries the pool directly) sees zero rows, not every tenant's rows. → Task 2.
5. **Same `Idempotency-Key` sent twice concurrently:** one row written; the second call gets `409 IDEMPOTENCY_IN_PROGRESS` or the replay. → Task 4 (`insert … on conflict do nothing` decides the winner).

---

### Task 1: API skeleton, env guard, clock, error contract, `/v1/meta`, embedded-Postgres harness

**Files:**
- Create: `apps/api/package.json` (`@tonnage/api`, private, `"type": "module"`; scripts `dev` = `tsx watch src/main.ts`, `test` = `vitest run`, `lint`, `typecheck`, `db:dev`, `db:migrate`, `db:generate`, `seed`), `tsconfig.json` (extends the repo base), `vitest.config.ts` (`globalSetup: test/setup/global.ts`, `fileParallelism: false`), `eslint.config.js` (repo config)
- Create: `apps/api/src/{env.ts,clock.ts,server.ts,main.ts}`, `src/http/errors.ts`, `src/routes/meta.ts`, `src/scripts/dev-db.ts`
- Create: `apps/api/test/setup/global.ts`, `test/helpers.ts`
- Modify: `packages/shared/src/errors.ts` (add `ERROR_MESSAGES`), `packages/mock-api/src/errors.ts` (import it; mock tests stay green)
- Create: root `.env.example`. Modify: `.gitignore` (`.pgdata*`, `apps/api/.env`), `pnpm-workspace.yaml` if apps are not already globbed
- Test: `test/env.test.ts`, `test/meta.test.ts`, `test/errors.test.ts`

**Interfaces:**
- Consumes: `ApiErrorBody`, `ErrorCode`, `metaSchema` (`@tonnage/shared`)
- Produces:
  - `loadEnv(raw: NodeJS.ProcessEnv): Env`. Keys: `NODE_ENV ('development'|'test'|'production')`, `PORT` (default 3000), `DATABASE_URL` (role `tonnage_app`), `MIGRATION_DATABASE_URL` (owner), `JWT_SECRET` (≥ 32 chars), `OTP_PROVIDER ('dev')`, `DEV_OTP_CODE` (default `'123456'`), `MIN_SUPPORTED_APP_VERSION` (default `'1.0.0'`), `RATE_LIMIT ('on'|'off', default 'on')`, `LOG_LEVEL` (default `'info'`). Throws `Error('Dev OTP provider is not allowed in production')`.
  - `interface Clock { now(): number }`; `systemClock: Clock`. Tests pass `createFakeClock` from `@tonnage/mock-api` (a devDependency, same shape).
  - `ERROR_MESSAGES: Record<ErrorCode, string>`, moved from `packages/mock-api/src/errors.ts` into `packages/shared/src/errors.ts`. The mock imports it from shared, so both servers send identical messages (for example `INTERNAL` → `'Something went wrong'`).
  - `class AppError extends Error { constructor(status: number, code: ErrorCode, details?: unknown) }`, with its message from `ERROR_MESSAGES` (same signature as the mock's `ApiError`).
  - `buildApp(deps: { env: Env; db: Db; clock: Clock; otp?: OtpProvider }): Promise<FastifyInstance>`: zod type provider, request id (`x-request-id` header honoured, else UUIDv7), pino logger (redacts `authorization`, `body.code`, `body.refreshToken`), error and not-found handlers, routes under `/v1`.
  - `GET /v1/meta` (public) → `metaSchema`: `{ minSupportedVersion, serverTime }`, with `serverTime` from the `Clock`.
  - `buildTestApp(opts?: { clock?: Clock }): Promise<{ app: FastifyInstance; db: Db; ownerDb: Db; clock: Clock; reset(): Promise<void> }>`

- [ ] **Step 1: Write `test/setup/global.ts`.** If `TEST_DATABASE_ADMIN_URL` is set (CI), use it. Otherwise start `embedded-postgres` (data dir `apps/api/.pgdata-test`, port 54329, user `postgres`), created on first run and reused after. Drop and recreate database `tonnage_test`; from Task 2 on, also run `migrate`. Expose both URLs with `provide()`. `reset()` truncates every table except drizzle's migrations table, as owner, with `restart identity cascade`.
- [ ] **Step 2: Write the failing tests.**

```ts
// env.test.ts
expect(() => loadEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'dev' })).toThrow('Dev OTP provider is not allowed in production');
expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow();
expect(loadEnv(base)).toMatchObject({ PORT: 3000, RATE_LIMIT: 'on', DEV_OTP_CODE: '123456' });
// meta.test.ts (fake clock at 2026-11-03T04:30:00Z)
expect(res.json()).toEqual({ minSupportedVersion: '1.0.0', serverTime: '2026-11-03T04:30:00.000Z' });
// errors.test.ts: throwaway routes registered in the test
// zod body failure   → 422 { code: 'VALIDATION', message, details: [{ path: ['mobile'], message }] }
// AppError(404,'NOT_FOUND') → 404 { code: 'NOT_FOUND', message }, exactly those keys
// plain Error        → 500 { code: 'INTERNAL', message: 'Something went wrong' }, no stack; logged at error with request id
// unknown route      → 404 { code: 'NOT_FOUND', message }
// malformed JSON     → 422 VALIDATION (not Fastify's default 400 shape)
```

- [ ] **Step 3: Run and confirm it fails.** `pnpm --filter @tonnage/api test` → FAIL (modules missing).
- [ ] **Step 4: Implement** `env.ts`, `clock.ts`, `http/errors.ts` (`setErrorHandler` + `setNotFoundHandler`, mapping Fastify's validation and content-type errors to the contract shape), `routes/meta.ts`, `server.ts`, `main.ts` (listens on `PORT`; graceful close on SIGTERM/SIGINT drains the pool). `scripts/dev-db.ts` starts embedded Postgres on port 54328, data dir `apps/api/.pgdata`, and prints both URLs. `.env.example` lists every key with local defaults.
- [ ] **Step 5: Run and confirm it passes.**
- [ ] **Step 6: Commit.** `feat(api): skeleton, env guard, clock, error contract, meta, embedded-postgres test harness`

---

### Task 2: M1 schema, migrations, DB roles and RLS

**Files:**
- Create: `apps/api/src/db/schema/{org,users,auth,system,index}.ts`, `src/db/rls.sql`, `src/db/client.ts`, `src/db/migrate.ts`
- Generate: `apps/api/drizzle/0000_*.sql` (`pnpm --filter @tonnage/api db:generate`; review the SQL before committing)
- Modify: `test/setup/global.ts` (run `migrate` after creating the DB)
- Test: `test/rls.test.ts`, `test/migrate.test.ts`

**Interfaces:**
- Produces:
  - Tables (spec §4). Every one has `created_at`, `updated_at timestamptz not null`, written from the `Clock` by handlers.
    - `tenants(id, name, settings jsonb not null)`: **no RLS** (read by id only, from auth and the pipeline).
    - `companies(id, tenant_id, code, name, gstin null, order_prefix, active bool default true, version int default 1)`; `unique(tenant_id, id)`, `unique(tenant_id, code)`.
    - `plants(id, tenant_id, company_id, name, location, active, version)`; FK `(tenant_id, company_id) → companies(tenant_id, id)`; `unique(tenant_id, id)`.
    - `users(id, tenant_id, name, mobile, role, active, invited_at, last_seen_at null, preferences jsonb default '{"unitBasis":"mt"}', version)`; `unique(tenant_id, mobile)`; `unique(tenant_id, id)`; `check (role in ('owner','city_staff','plant_head','supervisor'))`.
    - `user_plants(tenant_id, user_id, plant_id)`; PK `(user_id, plant_id)`; composite FKs to `users` and `plants`, `on delete cascade`.
    - `devices(id, tenant_id, user_id, push_token null, app_version null, last_seen_at)`; composite FK to `users`.
    - `otp_challenges(mobile pk, code_hash null, issued_at null, consumed bool, failures int, locked_until null)`: **no RLS**, one row per mobile (the mock's `OtpRec`).
    - `refresh_tokens(id, tenant_id, user_id, device_id, token_hash unique, expires_at, revoked_at null, rotated_at null, successor_enc bytea null)`: **no RLS** (looked up before the tenant is known; only `src/auth` touches it).
    - `idempotency_keys(tenant_id, user_id, key, route, status int null, body jsonb null, created_at)`; PK `(user_id, key)`. RLS on.
    - `activity_log(id, tenant_id, entity_type, entity_id, order_id null, action, actor_id, meta jsonb, at)`. RLS on.
  - `rls.sql` is idempotent and runs after the drizzle migrations:
    - creates role `tonnage_app LOGIN NOBYPASSRLS` if missing, and sets its password from `DATABASE_URL`;
    - grants DML on every table and default privileges for future ones;
    - `ENABLE ROW LEVEL SECURITY` plus policy `tenant_isolation` (`drop policy if exists` first) on `companies, plants, users, user_plants, devices, idempotency_keys, activity_log`;
    - `auth_lookup_mobile(p_mobile text) returns table(tenant_id uuid, user_id uuid, active boolean, tenant_name text)`, `SECURITY DEFINER SET search_path = public`, owned by the migration role, `revoke all from public`, `grant execute` to `tonnage_app`.
  - `type Db`, `type Tx` (drizzle on node-postgres). `createDb(url: string): { db: Db; close(): Promise<void> }`.
  - `withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`: opens a transaction and runs `select set_config('app.tenant_id', $1, true)` first.
  - `migrate(migrationUrl: string, appUrl: string): Promise<void>`

- [ ] **Step 1: Write the failing tests.**

```ts
// rls.test.ts (ownerInsert* helpers in test/helpers.ts use the owner connection)
it('Review Focus 4: app role without a tenant sees no rows', async () => {
  await ownerInsertCompany(tenantA, 'AIP');
  expect(await db.select().from(companies)).toEqual([]);
});
it('withTenant sees only its own rows', ...)                       // codes ['AIP'] for A, not B's 'XYZ'
it('cannot insert a row for another tenant', ...)                  // rejects /row-level security/
it('composite FK blocks a plant pointing at another tenant’s company', ...)  // rejects /foreign key/
it('tenant setting does not leak to the next transaction on the same connection', ...) // pool max 1: withTenant(A) then a plain select → []
it('auth_lookup_mobile finds users across tenants for login only', ...)      // 2 rows for a mobile in A and B
it('tonnage_app cannot turn RLS off', ...)                         // `alter table companies disable row level security` as app → rejects (not owner)
// migrate.test.ts
it('running migrate twice is a no-op and leaves one tenant_isolation policy per table', ...)
```

- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement** the schema files, run `db:generate`, then write `rls.sql`, `client.ts` and `migrate.ts`. Hook `migrate` into the global test setup and the `db:migrate` script.
- [ ] **Step 4: Run and confirm it passes.** Then do it by hand: `pnpm --filter @tonnage/api db:dev` in one terminal, and `db:migrate` twice in another. Both runs succeed.
- [ ] **Step 5: Commit.** `feat(api): M1 schema, migrations, tonnage_app role and RLS`

---

### Task 3: Auth — dev OTP, verify, JWT access, rotating refresh, sign-out

**Files:**
- Create: `src/auth/{otp-provider.ts,otp.service.ts,tokens.ts,crypto.ts}`, `src/routes/auth.ts`
- Test: `test/auth.test.ts`, `test/tokens.test.ts`, `test/auth-concurrency.test.ts`

**Interfaces:**
- Consumes: `requestCodeBodySchema`, `verifyCodeBodySchema`, `refreshBodySchema`, `signOutBodySchema`, `tokenPairSchema`, `requestCodeResponseSchema` (`@tonnage/shared`); `auth_lookup_mobile`, `withTenant` (Task 2); `Clock`, `AppError` (Task 1)
- Produces:
  - Constants (same values as `mock-api/src/sessions.ts` and `handlers/auth.ts`): `ACCESS_TTL_MS = 15 min`, `REFRESH_TTL_MS = 60 days` (rolling, from the last rotation), `REFRESH_GRACE_MS = 30 s`, `OTP_TTL_MS = 5 min`, `RESEND_AFTER_SECONDS = 30`, `MAX_FAILURES = 5`, `LOCK_MS = 15 min`. Every window is half-open: a 30 s window is over at exactly 30 000 ms.
  - `interface OtpProvider { send(mobile: string, code: string): Promise<void> }`; `DevOtpProvider` uses `env.DEV_OTP_CODE` and logs `{ mobile }` only.
  - `issueAccess(user: { id: string; tenantId: string }, deviceId: string, now: number): Promise<{ token: string; expiresAt: string }>`: HS256 with claims `sub`, `tid`, `did`, `iat`, `exp`.
  - `verifyAccess(token: string, now: number): Promise<{ userId: string; tenantId: string; deviceId: string } | null>`: jose `jwtVerify` with `currentDate: new Date(now)`, `algorithms: ['HS256']`.
  - `issuePair(tx, user, deviceId, now): Promise<TokenPair>`; `rotateRefresh(db, token, deviceId, now): Promise<TokenPair>`; `revokeAllForUser(tx, userId, now): Promise<void>`
  - `sealSuccessor(pair: TokenPair): Buffer`, `openSuccessor(buf: Buffer): TokenPair` in `crypto.ts` (Ruling 4)
  - Routes: `POST /v1/auth/request-code`, `/verify`, `/refresh`, `/sign-out` (204), all `public: true`

- [ ] **Step 1: Write the failing tests.** The contract (Task 8) covers the happy paths and error codes. These tests pin the database behaviour.

```ts
// auth.test.ts
it('the code hash and refresh tokens are stored hashed, never in plaintext', ...)       // scan rows for the token string → none
it('a failure is recorded even though the response is 401', ...)                       // failures = 1 in otp_challenges after OTP_INVALID
it('verify upserts devices(deviceId) for the user; sign-out clears its push_token', ...)
it('request-code calls the provider only for an active user’s number', ...)           // spy provider: 1 call for Rajesh, 0 for unknown/deactivated
it('no log line contains the code or a token', ...)                                    // capture pino stream across verify + refresh
// tokens.test.ts (fake clock)
it('access token is valid at 15 min − 1 ms and rejected at 15 min', ...)
it('a token signed with another secret, alg none, or tampered payload → null', ...)
// auth-concurrency.test.ts (real pool, Promise.all)
it('Review Focus 1: two concurrent refreshes of one token → both 200 with the identical pair; no tokens revoked', ...)
it('Review Focus 3: five wrong codes in parallel → locked; 123456 then 429 OTP_LOCKED', ...)
```

- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement.**
  - `verify` and `refresh` take `select … for update` on the `otp_challenges` row and the `refresh_tokens` row respectively, so concurrent calls serialise.
  - Tenant choice: `auth_lookup_mobile` returns more than one active user and there is no `tenantId` → `409 TENANT_CHOICE_REQUIRED`, `details` = `[{ tenantId, tenantName }]` sorted by name.
  - A refusal commits before it throws (Ruling 5). `verify` sets `last_seen_at` from the `Clock`.
  - Register `@fastify/rate-limit` on `/v1/auth/*` at 10 requests a minute per IP, only when `env.RATE_LIMIT === 'on'`.
- [ ] **Step 4: Run and confirm it passes.**
- [ ] **Step 5: Commit.** `feat(api): dev OTP sign-in, JWT access, rotating refresh with grace, sign-out`

---

### Task 4: Request pipeline — authenticate, policy guard, scope, transaction, redaction, idempotency

**Files:**
- Create: `src/http/{route.ts,auth-hook.ts,idempotency.ts,redact.ts}`, `src/services/activity.ts`
- Modify: `src/server.ts`
- Test: `test/pipeline.test.ts`, `test/idempotency-concurrency.test.ts`

**Interfaces:**
- Consumes: `can`, `plantScope`, `PlantScope`, `redactForRole`, `Action` (`@tonnage/shared`); `withTenant` (Task 2); `verifyAccess` (Task 3)
- Produces:
  - `defineRoute<B, Q>(app, method, url, config: { public?: true; action?: Action; idempotent?: true; body?: ZodType<B>; query?: ZodType<Q>; handler(ctx: RouteCtx<B, Q>): Promise<{ status?: number; body?: unknown }> })`. It throws at registration when neither `public` nor `action` is set, or when both `public` and `idempotent` are. Every route file uses it; no bare `app.get`.
  - `RouteCtx<B, Q> = { user: AuthedUser; scope: PlantScope; tx: Tx; params: Record<string, string>; query: Q; body: B; now: number; log: FastifyBaseLogger }`. Public routes get `{ db, params, query, body, now, log }` instead, with no `tx` or `user`.
  - `AuthedUser = { id; tenantId; tenantName; role: Role; plantIds: string[]; name; mobile; preferences: { unitBasis } }`, loaded inside the request transaction. Inactive or missing → `401 UNAUTHENTICATED`.
  - Order of checks is Ruling 10. The handler, the idempotency write and the activity rows share one transaction, rolled back on throw.
  - `logActivity(tx: Tx, a: AuthedUser, now: number, e: { entityType: string; entityId: string; action: string; meta?: Record<string, unknown>; orderId?: string }): Promise<void>`
  - `routeTable(app): { method: HttpMethod; url: string; public?: true; action?: Action; idempotent?: true }[]`: what `defineRoute` registered (read by Task 8's parity test).
  - Every request log line carries `reqId`, `tenantId`, `userId`, `route`, `status` and `ms`.

- [ ] **Step 1: Write the failing tests.** These use throwaway routes; the contract `pipeline` suite covers the HTTP behaviour.

```ts
it('a route without action or public fails buildApp', ...)
it('a handler that throws rolls back its writes and its activity row', ...)
it('redaction: supervisor gets no money keys from a nested payload; owner untouched', ...)   // keys from MONEY_KEYS
it('an idempotent handler that fails leaves no key row; the retry runs the handler again', ...)
it('a replay is redacted for the caller’s current role', ...)                                  // stored by owner-shaped body, replay as a demoted user
it('keys older than 24 h by the clock are purged and the key can be reused', ...)
// idempotency-concurrency.test.ts
it('Review Focus 5: two concurrent same-key POSTs → one handler run; other is 409 IDEMPOTENCY_IN_PROGRESS or the replay', ...)
```

- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement.**
  - Idempotency: the key row `(user_id, key, route, status null)` is inserted inside the request transaction, before the handler runs, with `insert … on conflict (user_id, key) do nothing returning`.
    - A concurrent second call blocks on the unique index until the first commits. Then it finds the stored row and replays it. If the first rolled back, the second's insert succeeds and its handler runs.
    - A conflicting row that is already committed with `status is null` cannot occur. Keep the `409 IDEMPOTENCY_IN_PROGRESS` branch anyway, for safety.
    - A non-2xx result rolls back the transaction, so the key row disappears with it (Ruling 7).
  - Redaction is applied to the body before `reply.send`, not in a global hook, so public routes and errors are untouched.
- [ ] **Step 4: Run and confirm it passes.**
- [ ] **Step 5: Commit.** `feat(api): request pipeline: auth, policy, scope, transaction, redaction, idempotency, activity`

---

### Task 5: Org API — companies, plants, tenant settings

**Files:**
- Create: `src/routes/{companies.ts,plants.ts,settings.ts}`, `src/views/org.ts` (row → `companySchema` / `plantSchema`)
- Test: `test/org.test.ts`

**Interfaces:**
- Consumes: Task 4; `companySchema`, `createCompanyBodySchema`, `updateCompanyBodySchema`, `plantSchema`, `createPlantBodySchema`, `updatePlantBodySchema`, `tenantSettingsSchema`, `DEFAULT_TENANT_SETTINGS`
- Produces (actions and behaviour exactly as `mock-api/src/handlers/{companies,plants,settings}.ts`):
  - `GET /v1/companies`, `GET /v1/companies/:id` (`self.view`; plant roles see only the companies of their plants, anything else → 404); `POST /v1/companies` (`companies.manage`, idempotent, 201); `PATCH /v1/companies/:id` (`companies.manage`, optimistic `version` → `409 STALE`; a duplicate code → `422 VALIDATION` at `['code']`)
  - `GET /v1/plants?companyId=`, `GET /v1/plants/:id` (`self.view`, scoped); `POST /v1/plants` (idempotent, 201); `PATCH /v1/plants/:id` (`version`)
  - `GET /v1/settings` (`self.view`); `PATCH /v1/settings` (`settings.manage`): body is any JSON object, merged over the current settings, then validated with `tenantSettingsSchema`. Unknown keys are dropped. `settings.updated` is logged only for keys whose value changed, with `meta.keys`.
  - `assertCompanyDeactivatable(tx: Tx, companyId: string): Promise<void>` (Ruling 8)
  - Activity: `company.created`, `company.updated`, `plant.created`, `plant.updated`, `settings.updated`

- [ ] **Step 1: Write the failing tests.** These cover only the database parts; behaviour is in the contract `org` and `settings` suites.

```ts
it('duplicate company code under concurrency → one 201, one 422 (unique index → VALIDATION, not 500)', ...)
it('PATCH with a stale version under concurrency → one 200, one 409 STALE (update … where version = $v)', ...)
it('settings PATCH with an unchanged value logs no activity row', ...)
```

- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement.** Map Postgres `23505` on `(tenant_id, code)` to `422 VALIDATION` at `['code']`. A version check is `update … where id = $1 and version = $2 returning`: zero rows → re-read; missing → 404, otherwise → 409 STALE.
- [ ] **Step 4: Run and confirm it passes.**
- [ ] **Step 5: Commit.** `feat(api): companies, plants and tenant settings`

---

### Task 6: Users API and `/v1/me`

**Files:**
- Create: `src/routes/{users.ts,me.ts}`, `src/views/users.ts` (row → `userSchema` with `status`; → `meSchema`)
- Test: `test/users.test.ts`

**Interfaces:**
- Consumes: Task 4; `plantRule`, `userSchema`, `inviteUserBodySchema`, `updateUserBodySchema`, `meSchema`, `updatePreferencesBodySchema`; `revokeAllForUser` (Task 3)
- Produces (as `mock-api/src/handlers/{users,me}.ts`):
  - `GET /v1/me`, `PATCH /v1/me/preferences` (`self.view`)
  - `GET /v1/users`, `POST /v1/users` (idempotent, 201, `invited_at` = now), `PATCH /v1/users/:id` (`version`), `POST /v1/users/:id/deactivate|reactivate` (all `users.manage`)
  - `status`: `inactive` if not active, else `invited` if `last_seen_at` is null, else `active`
  - Plant rule: unique plant ids are counted against `plantRule(role)` → `422 PLANT_RULE` with details `{ role, min, max }` (`max: null` for unbounded). A plant outside the tenant → 404. Switching to owner or city staff without `plantIds` clears plants.
  - `assertNotLastOwner(tx, tenantId, userId)`: `select id from users where tenant_id = $1 and role = 'owner' and active for update`, then `409 LAST_OWNER` if this user is the only one
  - Deactivate calls `revokeAllForUser`. A repeat deactivate or reactivate is a no-op 200.

- [ ] **Step 1: Write the failing tests.**

```ts
it('Review Focus 2: the only two owners deactivate each other concurrently → one 200, one 409 LAST_OWNER; one active owner remains', ...)
it('invite with a mobile already in the tenant under concurrency → one 201, one 409 MOBILE_EXISTS', ...)
it('changing role to city_staff deletes user_plants rows in the same transaction', ...)
```

- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm it passes.**
- [ ] **Step 5: Commit.** `feat(api): users, invite, roles and plants, deactivate, /me and unit preference`

---

### Task 7: Seed and dev workflow

**Files:**
- Create: `apps/api/src/scripts/seed.ts`
- Modify: root `package.json` scripts: `dev:db`, `dev:api`, `db:migrate`, `db:seed` (each `pnpm --filter @tonnage/api run …`)
- Modify: `README.md` (a "Run the API locally" section), `CLAUDE.md` (the Commands section and the `apps/api` line in Architecture)
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: Task 2 schema; `SAMPLE_WORLD`, `DEFAULT_TENANT_SETTINGS`
- Produces: `seed(ownerDb: Db, clock: Clock): Promise<{ tenantId: string }>`. It is idempotent (skips when `SAMPLE_WORLD`'s tenant id exists) and inserts the tenant, companies, plants, users and user plants with the **same ids** as `SAMPLE_WORLD`, so the mock, the contract and the database line up. Masters and orders come with B2.

- [ ] **Step 1: Write the failing test.** `seed` twice gives exactly the counts in `SAMPLE_WORLD` (4 companies, 4 plants, 8 users). Ravi's plant is Siltara. Deepak's `status` is `invited`. Every other user is `active`, with `last_seen_at` set to the clock's now (the mock seed does this in `store.ts`).
- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm it passes.**
- [ ] **Step 5: Manual check.** Run `pnpm dev:db`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev:api`. Then `curl -X POST localhost:3000/v1/auth/request-code -H "content-type: application/json" -d "{\"mobile\":\"9826100012\"}"` → 200. Verify with `123456` and a UUIDv7 `deviceId` → a token pair. `GET /v1/me` with it → Rajesh, owner.
- [ ] **Step 6: Commit.** `feat(api): seed the sample world and dev scripts`

---

### Task 8: M1 contract green against the real API, route parity, CI

**Files:**
- Modify: `packages/contract-tests/src/index.ts` (export `M1_SUITES` and `registerSuites`, Ruling 2; `registerAll` unchanged)
- Create: `apps/api/test/contract.test.ts`, `test/fastify-transport.ts`, `test/api-fixtures.ts`, `test/route-parity.test.ts`
- Modify: `.github/workflows/ci.yml` (`postgres:16` service, `POSTGRES_PASSWORD=postgres`, health check, env `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres`)

**Interfaces:**
- Consumes: `registerSuites`, `M1_SUITES`, `ContractTarget`, `ContractFixtures`; `buildTestApp` (Task 1); `seed` (Task 7); `ALL_ROUTES` from `@tonnage/mock-api`
- Produces:
  - `fastifyTransport(app: FastifyInstance): Transport`: maps a `TransportRequest` onto `app.inject`, lower-cases header names, parses JSON bodies, and turns a 204 into `body: undefined`
  - `apiFixtures(ownerDb: Db, clock: Clock): ContractFixtures`. `createTenant(name)` inserts the tenant, an owner with a fresh `+917…` mobile, company `TNT` and one plant, as the mock's `fixtures.ts` does. `addTruck` throws (Ruling 3).

- [ ] **Step 1: Write the route parity test.** For every M1 route in `ALL_ROUTES` (filtered by the Ruling 1 list), the API registers the same method and pattern with the same `public`, `action` and `idempotent`. The API registers no `/v1` route outside that list (compare `routeTable(app)` from Task 4). Run it: it fails if any route from Tasks 5–6 drifted from the mock. Fix the API, not the mock.
- [ ] **Step 2: Write `test/contract.test.ts`.** `registerSuites(M1_SUITES, async () => { … return { transport: fastifyTransport(app), reset: async () => { await reset(); await seed(ownerDb, clock); }, clock, fixtures: apiFixtures(ownerDb, clock), capabilities: { concurrency: true }, close: () => app.close() }; })`, with a fake clock at `Date.UTC(2026, 10, 3, 4, 30)` (the mock target's start) and `RATE_LIMIT=off`.
- [ ] **Step 3: Run it.** `pnpm --filter @tonnage/api exec vitest run test/contract.test.ts test/route-parity.test.ts`. Expected: all 71 M1 contract cases pass. A failure means the API diverges from the contract, so fix the API. Change a suite only if it contradicts the spec, and then re-run it against the mock as well (`pnpm --filter @tonnage/contract-tests test`).
- [ ] **Step 4: Run everything.** `pnpm lint && pnpm typecheck && pnpm test` → green. Push the branch: CI is green with the Postgres service.
- [ ] **Step 5: Smoke-test the app against the local API (Ruling 11).** Run `pnpm dev:api`, then `adb reverse tcp:3000 tcp:3000` and `EXPO_PUBLIC_API_MODE=http EXPO_PUBLIC_API_URL=http://127.0.0.1:3000 npx expo start --localhost --clear`. Sign in as Rajesh with `123456`, then open More → Companies, Users and Settings. Edit a company name and change unit basis to kg; both persist after a reload. Record what you saw in the PR description.
- [ ] **Step 6: Commit.** `test(api): M1 contract suite and route parity green against the real API`

---

## Carried forward from B1

From the final whole-branch review; each line is owned by the milestone named.

**B2 Global Constraints**
- Handlers throw or return 2xx: the API rolls back a returned non-2xx, unlike the mock.
- Quantity and money columns use `bigint(…, { mode: 'number' })`: `toWire`'s `JSON.stringify` throws on BigInt.
- CI runs `drizzle-kit check` and fails when `generate` produces a diff (spec §10.2).
- Decide `created_by` columns (spec §4) versus `activity_log`.
- Revoke insert/delete on `tenants` from `tonnage_app`; grant update only on `(settings, updated_at)`.
- `Idempotency-Key` length/charset → 422, with a contract test.
- The stale-replay-after-purge race on idempotency keys.
- 413 before auth is an exception to Ruling 10; record it.
- `findCompany` loads all visible companies; look one up by id.
- A shared lock-wait test helper with a time deadline, filtered by `datname`.
- `withTenant(tx)` leaves `app.tenant_id` set after its savepoint, until the outer transaction ends.

**B4**
- Clean up expired `refresh_tokens`.
- One push token per phone across tenants.
- The push-token `deviceId` is `string(8..64)`, not a uuid.
- Consider a composite FK `refresh_tokens.device_id` → `devices(tenant_id, id)`.

**B5**
- `trustProxy` from env; refresh exempt from or separately limited by the rate limit; mobile copy for `RATE_LIMITED`.
- The rate-limit store is in memory (one instance only).
- Queue the SMS send or fire and forget (timing enumeration); handle `otp.send` failing after the commit.
- An advisory lock in `migrate`.
- Copy `rls.sql` and `drizzle/` into the build.
- Check that `pnpm deploy --prod --filter @tonnage/api` doesn't pull the Expo tree.
- Reject the example `JWT_SECRET` in production.
- A successor box that fails to open (secret rotation) → refuse, not 500.
- pino redaction beyond the top level.
- Cap `x-request-id`.
- `migrate`'s rollback error masks the original error.
