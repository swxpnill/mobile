# B1 API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **When:** after the frontend milestones F1–F5 (spec §12). This plan was written alongside F1 and must be re-checked against the contract suite as it stands when B1 starts; F2–F5 will have added endpoints that B2–B4 cover, not B1.

**Goal:** The real API for the F1 contract — Fastify on PostgreSQL with tenant isolation enforced by RLS — passing the same `packages/contract-tests` suite the mock passes, plus the database-level guarantees the mock cannot give.

**Architecture:** `apps/api` is Fastify + Drizzle on PostgreSQL with two DB roles (owner for migrations, `tonnage_app` at runtime so RLS always applies). It reuses `packages/shared` (schemas, policy, `redactForRole`, errors, settings, `SAMPLE_WORLD`) unchanged. Route config (`public` / `action` / `idempotent`) mirrors `packages/mock-api`'s router so both enforce the same pipeline.

**Tech Stack:** Node 22, Fastify 5, fastify-type-provider-zod, zod, Drizzle ORM + drizzle-kit, node-postgres (`pg`), jose (JWT), uuid (v7), pino, @fastify/rate-limit, embedded-postgres (local/test), Vitest, GitHub Actions Postgres service.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md` (§2, §4, §5.5, §5.7, §7, §7.1, §9, §10). **Contract:** `packages/contract-tests` (F1 Task 5).

## Global Constraints

All Global Constraints of `2026-11-04-f1-app-foundation.md` apply, plus:
- Every tenant-owned table has `tenant_id uuid not null`; foreign keys between tenant tables are composite `(tenant_id, x_id)` → `(tenant_id, id)`.
- RLS on every tenant table: `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`; runtime role `tonnage_app` is never the table owner.
- IDs are UUIDv7 generated in application code.
- API refuses to boot if `NODE_ENV=production` and `OTP_PROVIDER=dev`.
- Code hashes and refresh tokens are stored as SHA-256 hashes; comparisons use `crypto.timingSafeEqual`.

## Review Focus

The five F1 Review Focus items are already pinned by the contract suite (Task 8 runs it here). The additional database-level risks:
1. **Two owners demote each other at the same moment** → exactly one succeeds; the other gets `409 LAST_OWNER` (row lock on owner rows). (Task 6)
2. **App role connecting without `app.tenant_id`** (a handler forgot `request.tx`) → sees zero rows rather than every tenant's rows. (Task 2)
3. **Same `Idempotency-Key` sent twice concurrently** → one 2xx, one `409 IDEMPOTENCY_IN_PROGRESS`, one row written. (Task 4; also the contract case skipped on the mock)
4. **Migrations run twice** (CI and a developer) → second run is a no-op, RLS policies not duplicated. (Task 2)
5. **Dev OTP in production config** → process exits at boot with the documented message. (Task 1)

---
### Task 1: API skeleton, env, error handler, `/v1/meta`, test harness with embedded Postgres

**Files:**
- Create: `apps/api/package.json` (`@tonnage/api`, deps listed in Tech Stack, scripts `dev` = `tsx watch src/main.ts`, `test` = `vitest run`, `db:dev`, `db:migrate`, `db:generate`, `seed`), `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`
- Create: `src/env.ts`, `src/server.ts`, `src/main.ts`, `src/http/errors.ts`, `src/routes/meta.ts`, `src/scripts/dev-db.ts`
- Create: `test/setup/global.ts`, `test/helpers.ts`
- Create: root `.env.example`
- Test: `test/meta.test.ts`, `test/env.test.ts`, `test/errors.test.ts`

**Interfaces:**
- Consumes: `ApiErrorBody`, `ErrorCode` (F1 Task 2)
- Produces:
  - `loadEnv(raw: NodeJS.ProcessEnv): Env` — keys: `NODE_ENV ('development'|'test'|'production')`, `PORT (default 3000)`, `DATABASE_URL` (runtime, role `tonnage_app`), `MIGRATION_DATABASE_URL` (owner), `JWT_SECRET (min 32 chars)`, `OTP_PROVIDER ('dev')`, `DEV_OTP_CODE (default '123456')`, `MIN_SUPPORTED_APP_VERSION (default '1.0.0')`. Throws `Error('Dev OTP provider is not allowed in production')` when production + dev.
  - `class AppError extends Error { constructor(code: ErrorCode, status: number, message: string, details?: unknown) }`
  - `buildApp(opts: { env: Env; db: Db }): Promise<FastifyInstance>` — registers zod type provider, error handler, routes under `/v1`.
  - `GET /v1/meta` → `{ minSupportedVersion: string, serverTime: ISO string }` (public)
  - Test helpers: `buildTestApp(): Promise<{ app: FastifyInstance; db: Db; reset(): Promise<void> }>`

- [ ] **Step 1: Test harness `test/setup/global.ts`**

Vitest `globalSetup`: if `TEST_DATABASE_ADMIN_URL` is set (CI), use it; else start `embedded-postgres` (data dir `apps/api/.pgdata-test`, port 54329, user `postgres`) — persistent across runs, created on first run. Then create database `tonnage_test` fresh (drop if exists), run Task 2's migrator against it (until Task 2 lands, just create the DB), and expose `DATABASE_URL`/`MIGRATION_DATABASE_URL` via `provide()`. Tests run with `fileParallelism: false` (single DB); `reset()` truncates all tables except migrations, as owner.

- [ ] **Step 2: Write failing tests**

```ts
// env.test.ts
expect(() => loadEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'dev' })).toThrow('Dev OTP provider is not allowed in production');
expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow();
expect(loadEnv(base).PORT).toBe(3000);
// meta.test.ts
const res = await app.inject({ method: 'GET', url: '/v1/meta' });
expect(res.statusCode).toBe(200);
expect(res.json()).toMatchObject({ minSupportedVersion: '1.0.0' });
expect(Date.parse(res.json().serverTime)).not.toBeNaN();
// errors.test.ts — register a throwaway route in the test
// zod failure → 422 { code:'VALIDATION', details:[{ path:['mobile'], ...}] }
// AppError('NOT_FOUND',404,'Not found') → 404 { code:'NOT_FOUND', message:'Not found' }
// thrown plain Error → 500 { code:'INTERNAL', message:'Something went wrong' } and no stack in body
// unknown route → 404 { code:'NOT_FOUND' }
```

- [ ] **Step 3: Run — FAIL** (`pnpm --filter @tonnage/api test`).

- [ ] **Step 4: Implement** `env.ts`, `http/errors.ts` (Fastify `setErrorHandler` + `setNotFoundHandler`; logs 5xx with pino), `routes/meta.ts`, `server.ts`, `main.ts`. `scripts/dev-db.ts` starts embedded Postgres on port 54328 with data dir `apps/api/.pgdata` (gitignored) and keeps running; prints the two URLs. Add `.pgdata*` to `.gitignore`. `.env.example` lists every env key with local defaults.

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit** — `git commit -m "feat(api): skeleton, env guard, error contract, meta, embedded-postgres test harness"`

---

### Task 2: M1 database schema, migrations, DB roles and RLS

**Files:**
- Create: `apps/api/src/db/schema/{org,users,auth,system,index}.ts`, `src/db/rls.sql`, `src/db/client.ts`, `src/db/migrate.ts`
- Generate: `apps/api/drizzle/0000_*.sql` via `pnpm --filter @tonnage/api db:generate`
- Modify: `test/setup/global.ts` (run `migrate` after DB creation)
- Test: `test/rls.test.ts`

**Interfaces:**
- Produces:
  - Tables (columns per spec §4; all have `created_at`, `updated_at` timestamptz default now()):
    - `tenants(id, name, settings jsonb default '{}')` — **no RLS** (read by id only, by auth/settings code).
    - `companies(id, tenant_id, code, name, gstin null, order_prefix, active default true, version int default 1)`; `unique(tenant_id, id)`, `unique(tenant_id, code)`.
    - `plants(id, tenant_id, company_id, name, location, active, version)`; FK `(tenant_id, company_id) → companies(tenant_id, id)`; `unique(tenant_id, id)`.
    - `users(id, tenant_id, name, mobile, role, active default true, invited_at, last_seen_at null, preferences jsonb default '{"unitBasis":"mt"}', version)`; `unique(tenant_id, mobile)`; check `role in (...)`.
    - `user_plants(tenant_id, user_id, plant_id)`; PK `(user_id, plant_id)`; composite FKs to users and plants, `on delete cascade`.
    - `devices(id, tenant_id, user_id, push_token null, app_version null, last_seen_at)`.
    - `otp_challenges(id, mobile, code_hash, expires_at, attempts int default 0, consumed_at null, created_at)` — **no RLS**; plus `otp_lockouts(mobile pk, locked_until)` — **no RLS**.
    - `refresh_tokens(id, tenant_id, user_id, device_id, token_hash unique, expires_at, revoked_at null, replaced_by null, rotated_at null)` — **no RLS** (looked up before tenant is known; only the auth module touches it).
    - `idempotency_keys(tenant_id, user_id, key, route, status_code null, response jsonb null, created_at)`; PK `(user_id, key)`.
    - `activity_log(id, tenant_id, entity_type, entity_id, order_id null, action, actor_id, meta jsonb, at)`.
  - `rls.sql` (idempotent, run after drizzle migrations by `migrate.ts`): creates role `tonnage_app` (password from `DATABASE_URL`) if missing; grants `select, insert, update, delete` on all tables and future tables to it; `ENABLE ROW LEVEL SECURITY` + policy `tenant_isolation` on every tenant table listed above (not `tenants`, `otp_*`, `refresh_tokens`); function `auth_lookup_mobile(p_mobile text) returns table(tenant_id uuid, user_id uuid, active boolean, tenant_name text)` `SECURITY DEFINER SET search_path = public`, owned by the migration role, `grant execute` to `tonnage_app`.
  - `type Db` (drizzle node-postgres instance on the `tonnage_app` pool)
  - `withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>` — opens a transaction and runs `select set_config('app.tenant_id', $1, true)` first.
  - `migrate(migrationUrl: string, appPassword: string): Promise<void>`

- [ ] **Step 1: Write failing tests `test/rls.test.ts`**

```ts
it('app role sees nothing without a tenant set', async () => {
  await ownerInsertCompany(tenantA, 'AIP');
  expect(await db.select().from(companies)).toEqual([]);
});
it('withTenant sees only its own rows', async () => {
  await ownerInsertCompany(tenantA, 'AIP'); await ownerInsertCompany(tenantB, 'XYZ');
  const rows = await withTenant(db, tenantA, tx => tx.select().from(companies));
  expect(rows.map(r => r.code)).toEqual(['AIP']);
});
it('cannot insert a row for another tenant', async () => {
  await expect(withTenant(db, tenantA, tx => tx.insert(companies).values({ ...c, tenantId: tenantB }))).rejects.toThrow(/row-level security/);
});
it('composite FK blocks a plant pointing at another tenant’s company', async () => {
  const foreign = await ownerInsertCompany(tenantB, 'XYZ');
  await expect(withTenant(db, tenantA, tx => tx.insert(plants).values({ tenantId: tenantA, companyId: foreign.id, ... }))).rejects.toThrow(/foreign key/);
});
it('auth_lookup_mobile bypasses RLS for login only', async () => {
  await ownerInsertUser(tenantA, '+919826100012');
  const r = await db.execute(sql`select * from auth_lookup_mobile('+919826100012')`);
  expect(r.rows).toHaveLength(1);
});
```

`ownerInsert*` helpers in `test/helpers.ts` use the owner connection.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement schema files, run `db:generate`, write `rls.sql`, `client.ts`, `migrate.ts`; hook `migrate` into global test setup and into `db:migrate` script.**

- [ ] **Step 4: Run — PASS.** Also run `pnpm --filter @tonnage/api db:dev` in one terminal and `db:migrate` in another; expect it to apply cleanly twice (idempotent).

- [ ] **Step 5: Commit** — `git commit -m "feat(api): M1 schema, migrations, tonnage_app role and RLS"`

---

### Task 3: Auth — dev OTP, verify, tokens, refresh rotation, sign-out

**Files:**
- Create: `src/auth/otp-provider.ts`, `src/auth/otp.service.ts`, `src/auth/tokens.ts`, `src/routes/auth.ts`
- Test: `test/auth.test.ts`, `test/tokens.test.ts`

**Interfaces:**
- Consumes: schemas from F1 Task 3, `auth_lookup_mobile` (Task 2), `AppError`
- Produces:
  - `interface OtpProvider { send(mobile: string, code: string): Promise<void> }`; `class DevOtpProvider implements OtpProvider` — code is always `env.DEV_OTP_CODE`, logs `{ mobile, code }` at info.
  - `requestCode(mobile: string): Promise<{ resendAfterSeconds: 30 }>` — always the same response whether or not the mobile exists (no user enumeration); creates a challenge and calls the provider only when the mobile exists and is active.
  - `verifyCode(input: VerifyCodeBody): Promise<TokenPair>`
  - `issueAccess(user: { id: string; tenantId: string }): Promise<{ token: string; expiresAt: Date }>`, `verifyAccess(token: string): Promise<{ sub: string; tid: string }>`
  - `issueRefresh(user, deviceId): Promise<string>`, `rotateRefresh(token: string, deviceId: string): Promise<TokenPair>`, `revokeAllForUser(userId: string): Promise<void>`
  - Routes: `POST /v1/auth/request-code`, `POST /v1/auth/verify`, `POST /v1/auth/refresh`, `POST /v1/auth/sign-out` (revokes the presented refresh token; 204)

- [ ] **Step 1: Write failing tests**

```ts
it('request-code responds identically for unknown numbers', ...)        // 200 { resendAfterSeconds: 30 } both
it('verify with the dev code returns a token pair and sets last_seen_at', ...)
it('wrong code → 401 OTP_INVALID; 5th wrong → 429 OTP_LOCKED for 15 min, even with right code', ...)
it('expired challenge (> 5 min, fake timers) → 401 OTP_EXPIRED', ...)
it('resend within 30 s → 429 OTP_RESEND_TOO_SOON', ...)
it('a consumed code cannot be reused', ...)
it('deactivated user cannot verify → 401 OTP_INVALID', ...)
it('same mobile in two tenants without tenantId → 409 TENANT_CHOICE_REQUIRED with details [{tenantId,tenantName}]; with tenantId → tokens', ...)
it('refresh rotates: old token revoked, new pair returned', ...)
it('Review Focus 3: same old token again within 30 s → same new pair (no lockout)', ...)
it('Review Focus 3: old token reused after 30 s → 401 and every token of the user revoked', ...)
it('refresh with another device id → 401', ...)
it('expired refresh (60 days) → 401; rolling: each rotation sets expires_at = now + 60 d', ...)
it('access token expires after 15 minutes', ...)                         // tokens.test.ts with fake clock
```

Code hashes use SHA-256 of `mobile + ':' + code` with `crypto.timingSafeEqual` comparison.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** Register `@fastify/rate-limit` on `/v1/auth/*` at 10 req/min per IP. **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(api): dev OTP sign-in, JWT access, rotating refresh tokens"`

---

### Task 4: Request pipeline — authenticate, policy guard, scope, redaction, idempotency

**Files:**
- Create: `src/http/auth-hook.ts`, `src/http/guards.ts`, `src/http/redact.ts`, `src/http/idempotency.ts`, `src/services/activity.ts`
- Modify: `src/server.ts` (register plugins; Fastify route config typing)
- Test: `test/pipeline.test.ts`

**Interfaces:**
- Consumes: `can`, `scopeKind`, `redactForRole` (F1 Task 2), `withTenant` (Task 2), `verifyAccess` (Task 3)
- Produces:
  - Route config `{ public?: true; action?: Action; idempotent?: true }` — every non-public route MUST declare `action` (server throws at startup otherwise).
  - `request.user: { id; tenantId; role: Role; plantIds: string[]; name; preferences }` (loaded from DB per request inside `withTenant`; inactive or missing → `401 UNAUTHENTICATED`)
  - `request.tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>` — `withTenant` bound to the user's tenant
  - `plantScope(user): { kind: 'all' } | { kind: 'plants'; plantIds: string[] }`
  - Money redaction: shared `redactForRole` (F1 Task 2) registered as a global `preSerialization` hook.
  - Idempotency: for routes with `idempotent: true`, missing header → `400 IDEMPOTENCY_KEY_REQUIRED`; first call inserts `(user_id, key, route)` with null response, runs, stores status + body; replay returns stored status + body with header `Idempotent-Replay: true`; concurrent duplicate while null → `409 IDEMPOTENCY_IN_PROGRESS`; same key on a different route → `422 VALIDATION`. Purge rows older than 24 h on each insert (cheap `delete … where created_at < now() - interval '24 hours'` limited to the user).
  - `logActivity(tx: Tx, e: { entityType: string; entityId: string; action: string; actorId: string; meta?: object; orderId?: string }): Promise<void>`

- [ ] **Step 1: Write failing tests** (register throwaway routes in the test app)

```ts
it('no token → 401 UNAUTHENTICATED; bad signature → 401', ...)
it('Review Focus 4: user deactivated after token issue → next request 401', ...)
it('role lacking the action → 403 FORBIDDEN', ...)              // supervisor hitting action 'users.manage'
it('route without action fails app startup', ...)
it('redaction: supervisor gets { id, qty } from { id, qty, rate, nested: [{ amount, x }] } → { id, qty, nested: [{ x }] }', ...)
it('redaction: owner payload untouched', ...)
it('idempotent route: replay returns same body + Idempotent-Replay header and runs handler once', ...)
it('idempotent route: missing key → 400 IDEMPOTENCY_KEY_REQUIRED', ...)
it('idempotent route: two concurrent same-key calls → one 2xx, one 409 IDEMPOTENCY_IN_PROGRESS', ...)
it('plantScope: supervisor → plants [p1]; city_staff → all', ...)
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(api): auth hook, policy guard, plant scope, money redaction, idempotency"`

---

### Task 5: Org API — companies, plants, tenant settings

**Files:**
- Create: `src/routes/companies.ts`, `src/routes/plants.ts`, `src/routes/settings.ts`
- Test: `test/companies.test.ts`, `test/plants.test.ts`, `test/settings.test.ts`

**Interfaces:**
- Consumes: Task 4 pipeline, schemas (F1 Task 3), `tenantSettingsSchema` (F1 Task 2)
- Produces:
  - `GET /v1/companies` (action `self.view` — every role may list companies, needed for unit switcher; plant_head/supervisor see only companies of their plants), `POST /v1/companies` (`companies.manage`, idempotent), `PATCH /v1/companies/:id` (`companies.manage`, optimistic `version`)
  - `GET /v1/plants?companyId=` (`self.view`, scoped), `POST /v1/plants` (`companies.manage`, idempotent), `PATCH /v1/plants/:id` (`companies.manage`, `version`)
  - `GET /v1/settings` (`self.view`), `PATCH /v1/settings` (`settings.manage`; body = partial settings, merged then validated with `tenantSettingsSchema`)
  - Every write calls `logActivity` (`company.created`, `company.updated`, `plant.created`, `plant.updated`, `settings.updated`).

- [ ] **Step 1: Write failing tests**

```ts
it('owner creates AIP; duplicate code in same tenant → 422 VALIDATION details path [code]', ...)
it('same code allowed in another tenant', ...)
it('PATCH with stale version → 409 STALE; success bumps version', ...)
it('Review Focus 5: GET/PATCH another tenant’s company id → 404 NOT_FOUND', ...)
it('city_staff POST company → 403', ...)
it('supervisor GET /companies → only the company of their plant', ...)
it('plant under a company of another tenant → 404 (company not found)', ...)
it('settings default on new tenant equal DEFAULT_TENANT_SETTINGS; PATCH { completionToleranceKg: 500 } persists; { externalUnitBasis: "lb" } → 422', ...)
```

Company deactivation must later be blocked while non-terminal sub-orders exist (spec §5.3), but no orders exist in M1. Add `assertCompanyDeactivatable(tx: Tx, companyId: string): Promise<void>` in `src/routes/companies.ts`, called by PATCH when `active` goes `true → false`; in M1 it always resolves. Test: deactivating a company with no orders succeeds. M2 adds the sub-order check inside this function.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(api): companies, plants and tenant settings endpoints"`

---

### Task 6: Users API and `/v1/me`

**Files:**
- Create: `src/routes/users.ts`, `src/routes/me.ts`
- Test: `test/users.test.ts`, `test/me.test.ts`

**Interfaces:**
- Consumes: pipeline (Task 4), `plantRule` (F1 Task 2), `revokeAllForUser` (Task 3)
- Produces:
  - `GET /v1/me` (`self.view`) → `meSchema`
  - `PATCH /v1/me/preferences` (`self.view`) body `{ unitBasis }` → `meSchema`
  - `GET /v1/users` (`users.manage`) → `userSchema[]` with `status`: `inactive` if `!active`, `invited` if `last_seen_at` is null, else `active`
  - `POST /v1/users` invite (`users.manage`, idempotent) → `userSchema`; sets `invited_at`
  - `PATCH /v1/users/:id` (`users.manage`, `version`) — name, role, plantIds
  - `POST /v1/users/:id/deactivate` and `/reactivate` (`users.manage`) — deactivate also calls `revokeAllForUser`

- [ ] **Step 1: Write failing tests**

```ts
it('invite supervisor with 1 plant → 201 status invited; with 0 or 2 plants → 422 PLANT_RULE', ...)
it('invite plant_head with 2 plants ok; city_staff with any plant → 422 PLANT_RULE', ...)
it('Review Focus 2: invite "09876543210" when +919876543210 exists in tenant → 409 MOBILE_EXISTS', ...)
it('changing supervisor → city_staff with plantIds [] succeeds and clears user_plants', ...)
it('plantIds from another tenant → 404 NOT_FOUND', ...)
it('Review Focus 1: owner deactivates self → 409 LAST_OWNER when they are the only active owner; demoting last owner → 409 LAST_OWNER', ...)
it('deactivate revokes refresh tokens and the user’s next request is 401', ...)
it('status becomes active after first verify (last_seen_at set)', ...)
it('/me returns role, plantIds, preferences.unitBasis "mt" by default; PATCH kg persists; "lb" → 422', ...)
it('city_staff GET /users → 403', ...)
```

`LAST_OWNER` check runs inside the same transaction with `select … for update` on the tenant's owner rows to avoid two owners demoting each other concurrently.

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(api): users and roles, invite, deactivate, /me and unit preference"`

---

### Task 7: Seed script and dev workflow

**Files:**
- Create: `apps/api/src/scripts/seed.ts`
- Modify: root `package.json` scripts: `dev:db` → api `db:dev`, `dev:api` → api `dev`, `db:migrate`, `db:seed`
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: schema (Task 2)
- Produces: `seed(db, ownerDb): Promise<{ tenantId: string }>` — idempotent (skips if tenant named "Agrawal Group" exists) inserting:
  - exactly the records in `SAMPLE_WORLD` from `@tonnage/shared` (F1 Task 4), with the same UUIDs, so mock and real data line up

- [ ] **Step 1: Write failing test** — `seed` twice yields exactly 4 companies, 4 plants, 8 users; Ravi's plant is Siltara; Deepak status `invited`.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Manual check** — `pnpm dev:db`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev:api`; `curl -X POST localhost:3000/v1/auth/request-code -H "content-type: application/json" -d "{\"mobile\":\"9826100012\"}"` → 200; verify with `123456` → token pair.
- [ ] **Step 6: Commit** — `git commit -m "feat(api): seed canvas sample world and dev scripts"`

---

### Task 8: Run the contract suite against the real API

**Files:**
- Create: `apps/api/test/contract.test.ts`, `apps/api/test/fastify-transport.ts`
- Modify: `.github/workflows/ci.yml` (add `postgres:16` service, `POSTGRES_PASSWORD=postgres`, env `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres`)

**Interfaces:**
- Consumes: `registerAll(factory)` and `ContractTarget` (F1 Task 5), `buildTestApp` (Task 1), `seed` (Task 7)
- Produces: `fastifyTransport(app: FastifyInstance): Transport` — maps `TransportRequest` to `app.inject` (lower-cases response header names, parses JSON bodies, 204 → `body: undefined`); `apiFixtures(db): MockFixtures` implementing `createTenant` with direct owner-connection inserts; a fake clock injected into `buildApp` (tokens, OTP expiry and grace windows read time only through it).

- [ ] **Step 1: Write `test/contract.test.ts`** — `registerAll(async () => { const { app, db, reset } = await buildTestApp({ clock }); await seed(...); return { transport: fastifyTransport(app), reset: async () => { await reset(); await seed(...) }, clock, fixtures: apiFixtures(db), capabilities: { concurrency: true } }; })`
- [ ] **Step 2: Run** — `pnpm --filter @tonnage/api exec vitest run test/contract.test.ts`. Expected: every contract case passes, including the concurrency case that is skipped on the mock. A failure means the API diverges from the contract: fix the API; change the suite only if it contradicts the spec, and then re-run it against the mock too.
- [ ] **Step 3: Run everything** — `pnpm lint && pnpm typecheck && pnpm test` → green; CI green with the Postgres service.
- [ ] **Step 4: Commit** — `git commit -m "test(api): contract suite green against the real API"`
