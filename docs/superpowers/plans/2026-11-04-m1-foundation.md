# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running monorepo where a seeded user signs in with a dev OTP on an Android phone (Expo Go), lands on the tab set for their role, picks MT or kg app-wide, and an owner manages companies, plants, users and tenant settings — on an API that enforces tenant isolation (RLS), role policy, plant scope, money redaction and idempotency.

**Architecture:** pnpm monorepo. `packages/shared` holds pure TypeScript used by both sides (units, formatters, mobile normalisation, roles, `policy.ts`, error codes, zod schemas). `apps/api` is Fastify + Drizzle on PostgreSQL with two DB roles (owner for migrations, `tonnage_app` at runtime so RLS always applies). `apps/mobile` is Expo + Expo Router + TanStack Query, styled from the canvas tokens.

**Tech Stack:** Node 22, pnpm (corepack), TypeScript 5 strict, Fastify 5, fastify-type-provider-zod, zod, Drizzle ORM + drizzle-kit, node-postgres (`pg`), jose (JWT), uuid (v7), pino, @fastify/rate-limit, embedded-postgres (local/test), Vitest, Expo (latest SDK) + Expo Router, TanStack Query, Zustand, react-hook-form, expo-secure-store, @react-native-async-storage/async-storage, expo-local-authentication, @expo-google-fonts/inter, jest-expo + @testing-library/react-native, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md` (read §2, §4 Organisation & access, §5.5, §5.6, §5.7, §7 auth/me/meta/org/settings + error contract, §8.1, §8.2, §8.4, §9, §10).

## Global Constraints

- Every tenant-owned table has `tenant_id uuid not null`; foreign keys between tenant tables are composite `(tenant_id, x_id)` → `(tenant_id, id)`.
- RLS on every tenant table: `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`. Runtime connects as role `tonnage_app` (not the table owner), so RLS is never bypassed by the app.
- IDs are UUIDv7 generated in application code (`uuid` package `v7()`).
- Quantities are integer kg; money is integer rupees; rates are whole ₹ per MT. No floats in storage or arithmetic on stored values.
- Business time zone `Asia/Kolkata`.
- Roles: `owner | city_staff | plant_head | supervisor`. Supervisor has exactly 1 plant; plant head ≥ 1; owner and city staff have none (see all).
- Unit basis `mt | kg`, default `mt`, per user (`users.preferences.unitBasis`), app-wide, display/input only. MT shows 3 decimals; kg whole numbers; ₹/kg input up to 3 decimals; ₹/MT whole rupees.
- Tenant settings defaults: `completionToleranceKg: 1000`, `agedOrderDays: 10`, `defaultPricing: 'basic_conversion'`, `allowHardDeleteAfterDispatch: true`, `externalUnitBasis: 'mt'`, `orderNumberFormat: 'SO-YYMM-0001'`.
- Access token 15 min (JWT HS256, claims `sub`, `tid`); refresh token opaque, 60 days rolling, rotated on use, stored as SHA-256 hash, revoked on deactivation.
- OTP: 6 digits, 5-minute expiry, 5 wrong attempts → number locked 15 min, resend allowed after 30 s. Only `DevOtpProvider` exists; API refuses to boot if `NODE_ENV=production` and `OTP_PROVIDER=dev`.
- Error body `{ code, message, details? }`; out-of-scope records return 404, never 403.
- Money keys are omitted (not null) for `plant_head` and `supervisor`.
- Mutating create routes require `Idempotency-Key`; stored 24 h.
- Fingerprint lock after 15 min idle.
- Mobile must run in **Expo Go** (no custom native modules) — use AsyncStorage where the spec says MMKV.
- Copy and colours come from the canvas; theme tokens exactly as in Task 11.
- Windows dev machine: all scripts must work in Git Bash and PowerShell (no `rm -rf`, `export X=`; use cross-platform Node scripts).

## Review Focus

1. **Owner deactivates themself or demotes the last active owner** → refused with `409 LAST_OWNER`; tenant can never be left without an owner. (Task 9)
2. **Mobile typed in different shapes** (`+91 98260 12345`, `9826012345`, `09826012345`, `919826012345`) → all resolve to `+919826012345`, the same user; `12345` or `5826012345` (not 6–9 start) rejected. (Tasks 2, 6, 9)
3. **Refresh sent twice in a row with the same token** (app retry on flaky network) → second call within 30 s of rotation returns the same new pair, not a reuse-lockout; a reuse after the 30 s grace revokes every token of that user. (Task 6)
4. **Deactivated user still holding a valid 15-min access token** → next request is `401 UNAUTHENTICATED` immediately (user row is loaded per request). (Task 7)
5. **Guessing another tenant's or another plant's record id** → `404 NOT_FOUND`, identical to a missing id. (Tasks 7, 8)

---

## File Structure

```
package.json                 root scripts (lint, typecheck, test, db:*), workspaces via pnpm
pnpm-workspace.yaml          apps/*, packages/*
.npmrc                       node-linker=hoisted (Expo/Metro in pnpm monorepo)
tsconfig.base.json           strict TS shared config
eslint.config.mjs, .prettierrc
.env.example
.github/workflows/ci.yml
CLAUDE.md, README.md

packages/shared/src/
  units.ts        unit basis display/parse (kg ↔ MT, ₹/MT ↔ ₹/kg)
  format.ts       ₹ Indian grouping, ₹ short (L/Cr), Indian integer grouping
  mobile.ts       normalizeIndianMobile
  roles.ts        Role, ROLES
  policy.ts       Action, can(), scopeKind(), describeRole(), MONEY_KEYS
  errors.ts       ErrorCode, ApiErrorBody
  settings.ts     TenantSettings schema + defaults
  schemas/        auth.ts, me.ts, org.ts, users.ts (zod request/response)
  index.ts

apps/api/src/
  env.ts                    zod-validated env, prod/dev-OTP guard
  server.ts                 buildApp(opts) → FastifyInstance
  main.ts                   listen
  db/client.ts              pools, withTenant()
  db/schema/org.ts          tenants, companies, plants
  db/schema/users.ts        users, user_plants, devices
  db/schema/auth.ts         otp_challenges, refresh_tokens
  db/schema/system.ts       idempotency_keys, activity_log
  db/schema/index.ts
  db/rls.sql                roles, grants, RLS policies, auth_lookup_mobile()
  db/migrate.ts             runs drizzle migrations + rls.sql as owner
  http/errors.ts            AppError, error handler
  http/auth-hook.ts         authenticate (JWT → load user)
  http/guards.ts            requireAction route option, scope helpers
  http/redact.ts            preSerialization money redaction
  http/idempotency.ts       Idempotency-Key plugin
  auth/otp-provider.ts      OtpProvider, DevOtpProvider
  auth/otp.service.ts       requestCode, verifyCode
  auth/tokens.ts            issueAccess, verifyAccess, issueRefresh, rotateRefresh, revokeAll
  routes/auth.ts, routes/me.ts, routes/meta.ts, routes/companies.ts,
  routes/plants.ts, routes/users.ts, routes/settings.ts
  services/activity.ts      logActivity()
  scripts/dev-db.ts         start embedded Postgres for dev
  scripts/seed.ts           canvas sample world
apps/api/test/
  setup/global.ts           embedded Postgres + migrations for tests
  helpers.ts                buildTestApp, factories, tokenFor
  *.test.ts

apps/mobile/
  app/_layout.tsx, app/(auth)/sign-in.tsx, app/(auth)/verify.tsx,
  app/(app)/_layout.tsx, app/(app)/(tabs)/_layout.tsx + one file per tab,
  app/(app)/companies/*, app/(app)/users/*, app/(app)/settings.tsx, app/lock.tsx
  src/theme/tokens.ts, src/theme/ThemeProvider.tsx
  src/ui/*.tsx              primitives
  src/api/client.ts         fetch wrapper (auth, refresh single-flight, idempotency, wake)
  src/api/hooks/*.ts        TanStack Query hooks per resource
  src/auth/session.ts       Zustand session + SecureStore
  src/auth/lock.ts          shouldLock(), useIdleLock()
  src/nav/tabs.ts           tabsForRole()
  src/prefs/unit-basis.ts   useUnitBasis()
  src/prefs/device.ts       theme mode, text size, fingerprint (AsyncStorage)
  test/*.test.tsx
```

---

### Task 1: Monorepo, tooling, CI, and `shared/units.ts`

**Files:**
- Create: root `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.github/workflows/ci.yml`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`, `packages/shared/src/units.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/units.test.ts`

**Interfaces:**
- Produces:
  - `type UnitBasis = 'mt' | 'kg'`
  - `type ParseResult = { ok: true; value: number } | { ok: false; error: 'EMPTY' | 'INVALID' | 'TOO_MANY_DECIMALS' }`
  - `toDisplayQty(kg: number, basis: UnitBasis, opts?: { withUnit?: boolean }): string`
  - `parseQtyInput(input: string, basis: UnitBasis): ParseResult` (value in kg)
  - `toDisplayRate(ratePerMt: number, basis: UnitBasis, opts?: { withUnit?: boolean }): string` (includes leading `₹`)
  - `parseRateInput(input: string, basis: UnitBasis): ParseResult` (value in ₹/MT)
  - `unitLabel(basis: UnitBasis): 'MT' | 'kg'`
  - root scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test` (runs every workspace's `test`)

- [ ] **Step 1: Scaffold the workspace**

Run `corepack enable` then `corepack prepare pnpm@latest --activate`; `pnpm init` at root. `pnpm-workspace.yaml` lists `apps/*` and `packages/*`. `.npmrc`: `node-linker=hoisted`. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `module`/`moduleResolution` `NodeNext` for packages (mobile overrides). ESLint flat config with `typescript-eslint` recommended + Prettier. Root scripts use `pnpm -r --if-present run <script>`. `packages/shared` is `"name": "@tonnage/shared"`, `"type": "module"`, exports `./src/index.ts` directly (consumed as TS source by api via tsx/vitest and by Metro).

Verify: `pnpm install` succeeds; `pnpm typecheck` exits 0.

- [ ] **Step 2: Write failing tests `packages/shared/src/units.test.ts`**

```ts
describe('toDisplayQty', () => {
  it('mt: 3 decimals with Indian grouping', () => {
    expect(toDisplayQty(24180, 'mt')).toBe('24.180');
    expect(toDisplayQty(1248640, 'mt', { withUnit: true })).toBe('1,248.640 MT');
    expect(toDisplayQty(0, 'mt')).toBe('0.000');
  });
  it('kg: whole number with Indian grouping', () => {
    expect(toDisplayQty(24180, 'kg')).toBe('24,180');
    expect(toDisplayQty(1248640, 'kg', { withUnit: true })).toBe('12,48,640 kg');
  });
});
describe('parseQtyInput', () => {
  it('mt', () => {
    expect(parseQtyInput('24.18', 'mt')).toEqual({ ok: true, value: 24180 });
    expect(parseQtyInput(' 1,248.640 ', 'mt')).toEqual({ ok: true, value: 1248640 });
    expect(parseQtyInput('.5', 'mt')).toEqual({ ok: true, value: 500 });
    expect(parseQtyInput('24.1805', 'mt')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
    expect(parseQtyInput('', 'mt')).toEqual({ ok: false, error: 'EMPTY' });
    expect(parseQtyInput('-2', 'mt')).toEqual({ ok: false, error: 'INVALID' });
    expect(parseQtyInput('2.4.1', 'mt')).toEqual({ ok: false, error: 'INVALID' });
  });
  it('kg', () => {
    expect(parseQtyInput('24,180', 'kg')).toEqual({ ok: true, value: 24180 });
    expect(parseQtyInput('24180.5', 'kg')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
  });
});
describe('rates', () => {
  it('display', () => {
    expect(toDisplayRate(46300, 'mt', { withUnit: true })).toBe('₹46,300 / MT');
    expect(toDisplayRate(46300, 'kg', { withUnit: true })).toBe('₹46.300 / kg');
    expect(toDisplayRate(150, 'kg')).toBe('₹0.150');
  });
  it('parse', () => {
    expect(parseRateInput('46,300', 'mt')).toEqual({ ok: true, value: 46300 });
    expect(parseRateInput('46300.5', 'mt')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
    expect(parseRateInput('46.3', 'kg')).toEqual({ ok: true, value: 46300 });
    expect(parseRateInput('0.45', 'kg')).toEqual({ ok: true, value: 450 });
    expect(parseRateInput('46.3051', 'kg')).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
  });
  it('round-trips losslessly', () => {
    for (const kg of [0, 1, 999, 1000, 24180, 1248640]) {
      for (const b of ['mt', 'kg'] as const) expect(parseQtyInput(toDisplayQty(kg, b), b)).toEqual({ ok: true, value: kg });
    }
    for (const r of [0, 1, 150, 46300, 4630000]) {
      for (const b of ['mt', 'kg'] as const) expect(parseRateInput(toDisplayRate(r, b).replace('₹', ''), b)).toEqual({ ok: true, value: r });
    }
  });
});
```

Also add a `fast-check` property: for any integer kg in `[0, 10^10]` and any basis, parse(display(kg)) === kg.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @tonnage/shared test`
Expected: FAIL — `units.ts` exports not found.

- [ ] **Step 4: Implement `packages/shared/src/units.ts`**

Pure string/integer arithmetic only — never `parseFloat` or `/ 1000` on display. Parsing: trim, strip `,` and spaces, empty → `EMPTY`; match `^\d*(\.\d*)?$` with at least one digit else `INVALID`; decimals beyond the basis limit (MT qty 3, kg qty 0, MT rate 0, kg rate 3) → `TOO_MANY_DECIMALS`; value = `whole * 1000 + Number(frac.padEnd(3,'0'))` for 3-decimal inputs. Display splits `Math.trunc(n / 1000)` and `n % 1000` (padded to 3). Indian grouping comes from Task 2's `groupIndian`; until Task 2 exists, put `groupIndian(intDigits: string): string` in `format.ts` now (last 3 digits, then groups of 2).

- [ ] **Step 5: Run tests — PASS**

Run: `pnpm --filter @tonnage/shared test`
Expected: all pass.

- [ ] **Step 6: CI workflow `.github/workflows/ci.yml`**

On push/PR: checkout, setup-node 22, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Add a `postgres:16` service with `POSTGRES_PASSWORD=postgres` and env `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres` (used from Task 4).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold, CI, shared unit-basis conversions"
```

---

### Task 2: Shared formatters, mobile normalisation, roles, policy, errors, settings

**Files:**
- Create: `packages/shared/src/format.ts` (extend), `mobile.ts`, `roles.ts`, `policy.ts`, `errors.ts`, `settings.ts`
- Test: `format.test.ts`, `mobile.test.ts`, `policy.test.ts`, `settings.test.ts`

**Interfaces:**
- Produces:
  - `groupIndian(intDigits: string): string`, `formatRupees(n: number): string`, `formatRupeesShort(n: number): string`
  - `normalizeIndianMobile(input: string): string | null` → `+91XXXXXXXXXX`
  - `type Role = 'owner' | 'city_staff' | 'plant_head' | 'supervisor'`, `ROLES: readonly Role[]`
  - `type Action` = union of: `'order.create' | 'order.edit' | 'order.duplicate' | 'order.shortClose' | 'order.reopen' | 'order.editDispatched' | 'order.hardDelete' | 'order.view' | 'truck.assign' | 'truck.edit' | 'truck.cancel' | 'weighment.capture' | 'weighment.correctAfterDispatch' | 'dispatch.view' | 'tasks.view' | 'masters.manage' | 'import.run' | 'broker.pay' | 'reports.view' | 'reports.doneToday' | 'money.view' | 'users.manage' | 'companies.manage' | 'settings.manage' | 'self.view'`
  - `can(role: Role, action: Action): boolean`
  - `scopeKind(role: Role): 'all' | 'plants'`
  - `plantRule(role: Role): { min: number; max: number }` → owner/city_staff `{0,0}`, plant_head `{1, Infinity}`, supervisor `{1,1}`
  - `describeRole(role: Role): { can: string[]; cannot: string[] }` (strings may contain `{plant}`)
  - `MONEY_KEYS: ReadonlySet<string>`
  - `type ErrorCode` and `interface ApiErrorBody { code: ErrorCode; message: string; details?: unknown }`
  - `tenantSettingsSchema` (zod) and `DEFAULT_TENANT_SETTINGS`, `type TenantSettings`

- [ ] **Step 1: Write failing tests**

```ts
// format.test.ts
expect(formatRupees(146000)).toBe('₹1,46,000');
expect(formatRupees(3864200)).toBe('₹38,64,200');
expect(formatRupees(-40000)).toBe('−₹40,000');           // U+2212, as on the canvas
expect(formatRupees(0)).toBe('₹0');
expect(formatRupeesShort(5580000)).toBe('₹55.80 L');
expect(formatRupeesShort(14600000)).toBe('₹1.46 Cr');
expect(formatRupeesShort(86400)).toBe('₹86,400');        // below 1 lakh → full
expect(formatRupeesShort(482000)).toBe('₹4.82 L');
// mobile.test.ts
for (const s of ['+91 98260 12345', '9826012345', '09826012345', '919826012345', '+91-98260-12345'])
  expect(normalizeIndianMobile(s)).toBe('+919826012345');
for (const s of ['12345', '5826012345', '98260123456', '', 'abc']) expect(normalizeIndianMobile(s)).toBeNull();
// policy.test.ts — the spec §5.5 table, row by row
const T = (role: Role, allowed: Action[]) => ACTIONS.forEach(a => expect([role, a, can(role, a)]).toEqual([role, a, allowed.includes(a)]));
T('owner', ACTIONS);
T('city_staff', ['order.create','order.edit','order.duplicate','order.shortClose','order.view','truck.assign','truck.edit','truck.cancel','dispatch.view','masters.manage','import.run','broker.pay','reports.view','money.view','self.view']);
T('plant_head', ['order.view','dispatch.view','self.view']);
T('supervisor', ['weighment.capture','tasks.view','reports.doneToday','self.view']);
expect(plantRule('supervisor')).toEqual({ min: 1, max: 1 });
expect(scopeKind('plant_head')).toBe('plants');
expect(MONEY_KEYS.has('rate')).toBe(true);
// settings.test.ts
expect(tenantSettingsSchema.parse({})).toEqual(DEFAULT_TENANT_SETTINGS);
expect(DEFAULT_TENANT_SETTINGS.completionToleranceKg).toBe(1000);
expect(() => tenantSettingsSchema.parse({ completionToleranceKg: -1 })).toThrow();
```

`ACTIONS` is exported from `policy.ts` as the readonly array behind the `Action` type.

- [ ] **Step 2: Run — FAIL** (`pnpm --filter @tonnage/shared test`, missing exports).

- [ ] **Step 3: Implement**

- `formatRupeesShort`: ≥ 1,00,00,000 → crore, ≥ 1,00,000 → lakh, 2 decimals, round half up on integer paise-style maths (`Math.round` is acceptable here — display only).
- `normalizeIndianMobile`: strip non-digits; accept 10 digits, `0`+10, `91`+10; first of the 10 must be 6–9.
- `MONEY_KEYS`: `rate, basicRate, basicRateSnapshot, conversion, conversionSnapshot, conversionPerMt, overpricePerMt, commissionPerMt, commissionPerMtSnapshot, defaultCommissionPerMt, value, lineValue, orderValue, amount, amountRupees, due, earned, paid, tdsRupees, billedRate`.
- `describeRole` copy (from the Invite user artboard):
  - supervisor — can: `See trucks assigned to {plant}`, `Capture tare and gross weight, works offline`; cannot: `See rates, order values or broker money`, `Create orders or assign vehicles`
  - plant_head — can: `See orders and dispatch of {plant}`; cannot: `See rates, order values or broker money`, `Create or edit orders, assign vehicles or weigh trucks`
  - city_staff — can: `Create and edit orders for any unit`, `Assign vehicles`, `Manage parties and products`, `Record broker payments`, `See reports`; cannot: `Delete orders`, `Change settings or users`
  - owner — can: `Everything, including delete and settings`; cannot: none
- `ErrorCode` M1 values: `VALIDATION, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, STALE, OTP_INVALID, OTP_EXPIRED, OTP_LOCKED, OTP_RESEND_TOO_SOON, TENANT_CHOICE_REQUIRED, MOBILE_EXISTS, LAST_OWNER, PLANT_RULE, IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_IN_PROGRESS, INTERNAL`.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(shared): formatters, mobile normalisation, roles, policy, errors, settings"`

---

### Task 3: Shared zod schemas for M1 endpoints

**Files:**
- Create: `packages/shared/src/schemas/auth.ts`, `me.ts`, `org.ts`, `users.ts`; export from `index.ts`
- Test: `packages/shared/src/schemas/schemas.test.ts`

**Interfaces:**
- Produces (each a zod schema plus `z.infer` type of the same name without `Schema`):
  - `requestCodeBodySchema { mobile: string }` (transform via `normalizeIndianMobile`, invalid → issue)
  - `verifyCodeBodySchema { mobile, code: /^\d{6}$/, deviceId: uuid, tenantId?: uuid }`
  - `tokenPairSchema { accessToken, refreshToken, accessExpiresAt: ISO }`
  - `refreshBodySchema { refreshToken, deviceId }`
  - `meSchema { id, name, mobile, role, plantIds: uuid[], preferences: { unitBasis }, tenant: { id, name } }`
  - `updatePreferencesBodySchema { unitBasis: 'mt'|'kg' }`
  - `companySchema { id, code: /^[A-Z]{2,5}$/, name, gstin: string|null, orderPrefix, active, version }`, `createCompanyBodySchema`, `updateCompanyBodySchema` (partial + required `version`)
  - `plantSchema { id, companyId, name, location, active, version }`, `createPlantBodySchema`, `updatePlantBodySchema`
  - `userSchema { id, name, mobile, role, plantIds, active, status: 'active'|'invited'|'inactive', version }`, `inviteUserBodySchema { name, mobile, role, plantIds }`, `updateUserBodySchema { name?, role?, plantIds?, version }`
  - `gstinSchema` — 15 chars `^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`

- [ ] **Step 1: Write failing tests**

```ts
expect(requestCodeBodySchema.parse({ mobile: '98260 12345' })).toEqual({ mobile: '+919826012345' });
expect(requestCodeBodySchema.safeParse({ mobile: '123' }).success).toBe(false);
expect(gstinSchema.safeParse('22AAJCA4410K1ZQ').success).toBe(true);   // Aarav, from canvas
expect(gstinSchema.safeParse('22AAJCA4410K1Z').success).toBe(false);
expect(inviteUserBodySchema.parse({ name: 'Deepak Sahu', mobile: '9876543210', role: 'supervisor', plantIds: [id] }).mobile).toBe('+919876543210');
expect(updateCompanyBodySchema.safeParse({ name: 'X' }).success).toBe(false); // version required
```

Plant-count rules are NOT in the schema (they depend on role and are enforced server-side with `PLANT_RULE`).

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(shared): zod schemas for auth, me, org, users"`

---

### Task 4: API skeleton, env, error handler, `/v1/meta`, test harness with embedded Postgres

**Files:**
- Create: `apps/api/package.json` (`@tonnage/api`, deps listed in Tech Stack, scripts `dev` = `tsx watch src/main.ts`, `test` = `vitest run`, `db:dev`, `db:migrate`, `db:generate`, `seed`), `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`
- Create: `src/env.ts`, `src/server.ts`, `src/main.ts`, `src/http/errors.ts`, `src/routes/meta.ts`, `src/scripts/dev-db.ts`
- Create: `test/setup/global.ts`, `test/helpers.ts`
- Create: root `.env.example`
- Test: `test/meta.test.ts`, `test/env.test.ts`, `test/errors.test.ts`

**Interfaces:**
- Consumes: `ApiErrorBody`, `ErrorCode` (Task 2)
- Produces:
  - `loadEnv(raw: NodeJS.ProcessEnv): Env` — keys: `NODE_ENV ('development'|'test'|'production')`, `PORT (default 3000)`, `DATABASE_URL` (runtime, role `tonnage_app`), `MIGRATION_DATABASE_URL` (owner), `JWT_SECRET (min 32 chars)`, `OTP_PROVIDER ('dev')`, `DEV_OTP_CODE (default '123456')`, `MIN_SUPPORTED_APP_VERSION (default '1.0.0')`. Throws `Error('Dev OTP provider is not allowed in production')` when production + dev.
  - `class AppError extends Error { constructor(code: ErrorCode, status: number, message: string, details?: unknown) }`
  - `buildApp(opts: { env: Env; db: Db }): Promise<FastifyInstance>` — registers zod type provider, error handler, routes under `/v1`.
  - `GET /v1/meta` → `{ minSupportedVersion: string, serverTime: ISO string }` (public)
  - Test helpers: `buildTestApp(): Promise<{ app: FastifyInstance; db: Db; reset(): Promise<void> }>`

- [ ] **Step 1: Test harness `test/setup/global.ts`**

Vitest `globalSetup`: if `TEST_DATABASE_ADMIN_URL` is set (CI), use it; else start `embedded-postgres` (data dir `apps/api/.pgdata-test`, port 54329, user `postgres`) — persistent across runs, created on first run. Then create database `tonnage_test` fresh (drop if exists), run Task 5's migrator against it (until Task 5 lands, just create the DB), and expose `DATABASE_URL`/`MIGRATION_DATABASE_URL` via `provide()`. Tests run with `fileParallelism: false` (single DB); `reset()` truncates all tables except migrations, as owner.

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

### Task 5: M1 database schema, migrations, DB roles and RLS

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

### Task 6: Auth — dev OTP, verify, tokens, refresh rotation, sign-out

**Files:**
- Create: `src/auth/otp-provider.ts`, `src/auth/otp.service.ts`, `src/auth/tokens.ts`, `src/routes/auth.ts`
- Test: `test/auth.test.ts`, `test/tokens.test.ts`

**Interfaces:**
- Consumes: schemas from Task 3, `auth_lookup_mobile` (Task 5), `AppError`
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

### Task 7: Request pipeline — authenticate, policy guard, scope, redaction, idempotency

**Files:**
- Create: `src/http/auth-hook.ts`, `src/http/guards.ts`, `src/http/redact.ts`, `src/http/idempotency.ts`, `src/services/activity.ts`
- Modify: `src/server.ts` (register plugins; Fastify route config typing)
- Test: `test/pipeline.test.ts`

**Interfaces:**
- Consumes: `can`, `scopeKind`, `MONEY_KEYS` (Task 2), `withTenant` (Task 5), `verifyAccess` (Task 6)
- Produces:
  - Route config `{ public?: true; action?: Action; idempotent?: true }` — every non-public route MUST declare `action` (server throws at startup otherwise).
  - `request.user: { id; tenantId; role: Role; plantIds: string[]; name; preferences }` (loaded from DB per request inside `withTenant`; inactive or missing → `401 UNAUTHENTICATED`)
  - `request.tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>` — `withTenant` bound to the user's tenant
  - `plantScope(user): { kind: 'all' } | { kind: 'plants'; plantIds: string[] }`
  - `redactForRole(role: Role, payload: unknown): unknown` — deep-walk, omit `MONEY_KEYS` for `plant_head`/`supervisor`; registered as a global `preSerialization` hook.
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

### Task 8: Org API — companies, plants, tenant settings

**Files:**
- Create: `src/routes/companies.ts`, `src/routes/plants.ts`, `src/routes/settings.ts`
- Test: `test/companies.test.ts`, `test/plants.test.ts`, `test/settings.test.ts`

**Interfaces:**
- Consumes: Task 7 pipeline, schemas (Task 3), `tenantSettingsSchema` (Task 2)
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

### Task 9: Users API and `/v1/me`

**Files:**
- Create: `src/routes/users.ts`, `src/routes/me.ts`
- Test: `test/users.test.ts`, `test/me.test.ts`

**Interfaces:**
- Consumes: pipeline (Task 7), `plantRule` (Task 2), `revokeAllForUser` (Task 6)
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

### Task 10: Seed script and dev workflow

**Files:**
- Create: `apps/api/src/scripts/seed.ts`
- Modify: root `package.json` scripts: `dev:db` → api `db:dev`, `dev:api` → api `dev`, `db:migrate`, `db:seed`
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: schema (Task 5)
- Produces: `seed(db, ownerDb): Promise<{ tenantId: string }>` — idempotent (skips if tenant named "Agrawal Group" exists) creating, from the canvas:
  - Tenant "Agrawal Group"
  - Companies: `AIP` Aarav Ispat Pvt Ltd (GSTIN 22AAJCA4410K1ZQ, prefix SO-AIP) → plant "Siltara", Raipur; `VSL` Vrinda Steels LLP (22AAKFV2093P1ZC) → "Urla", Raipur; `KRM` Kalinga Rolling Mills (22AADFK7781M1Z2) → "Borai", Durg; `NAP` Nandan Alloys Pvt Ltd (22AAHCN6620Q1Z7) → "Tilda", Raipur
  - Users: Rajesh Agrawal owner +919826100012; Priya Sharma city_staff +919826100013; Amit Verma city_staff +919425067890; Ravi Verma supervisor Siltara +919826100014; Sanjay Patel supervisor Borai +919826100015; Mohan Kurre supervisor Urla +919826100016; Deepak Sahu supervisor Tilda +919826100017 (invited, never seen); plant head "Kiran Rao" for Siltara +919826100018 (not on canvas; needed to exercise the role)

- [ ] **Step 1: Write failing test** — `seed` twice yields exactly 4 companies, 4 plants, 8 users; Ravi's plant is Siltara; Deepak status `invited`.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Manual check** — `pnpm dev:db`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev:api`; `curl -X POST localhost:3000/v1/auth/request-code -H "content-type: application/json" -d "{\"mobile\":\"9826100012\"}"` → 200; verify with `123456` → token pair.
- [ ] **Step 6: Commit** — `git commit -m "feat(api): seed canvas sample world and dev scripts"`

---

### Task 11: Mobile scaffold, theme tokens, UI primitives

**Files:**
- Create: `apps/mobile` via `npx create-expo-app@latest apps/mobile --template blank-typescript`, then `npx expo install expo-router expo-linking expo-constants expo-status-bar react-native-safe-area-context react-native-screens expo-secure-store @react-native-async-storage/async-storage expo-local-authentication expo-crypto @expo-google-fonts/inter expo-font` and `pnpm add @tanstack/react-query zustand react-hook-form @hookform/resolvers @tonnage/shared@workspace:*`; dev: `jest-expo @testing-library/react-native`
- Create: `src/theme/tokens.ts`, `src/theme/ThemeProvider.tsx`, `src/ui/{Screen,Header,Group,Row,Badge,UnitTag,Chip,Button,SegmentedControl,OtpInput,QtyText,MoneyText,EmptyState,Text}.tsx`, `src/prefs/device.ts`
- Test: `test/theme.test.tsx`, `test/ui.test.tsx`

**Interfaces:**
- Consumes: `toDisplayQty`, `toDisplayRate`, `formatRupees`, `formatRupeesShort`, `UnitBasis` (Tasks 1–2)
- Produces:
  - `lightTokens`, `darkTokens: Tokens` — exact values from the canvas:
    - light: `bg #F4F5F7, card #FFFFFF, ctl #EEEFF2, act #E4E6EA, bd rgba(11,13,18,.08), bd2 rgba(11,13,18,.14), tx #0F1115, tx2 #4B505A, tx3 #626771, inv #2563EB, invtx #FFFFFF, br #2563EB, brt #1D4ED8, brs rgba(37,99,235,.10), vi #5B3CC4, vis rgba(109,74,224,.10), ok #089981, okt #067A6A, oks rgba(8,153,129,.11), wnt #8F5E12, wns rgba(183,121,31,.13), dgt #D21E2B, dgs rgba(242,54,69,.09)`
    - dark (Graphite): `bg #09090B, card #111114, ctl #18181C, act #25252B, bd rgba(255,255,255,.06), bd2 rgba(255,255,255,.10), tx #F4F3EF, tx2 #A3A3A9, tx3 #85858D, inv #4F86F7, invtx #FFFFFF, br #4F86F7, brt #8AB0FF, brs rgba(79,134,247,.16), vi #A994FF, vis rgba(155,133,245,.16), ok #26A69A, okt #26A69A, oks rgba(38,166,154,.14), wnt #E5A93B, wns rgba(229,169,59,.14), dgt #EF5350, dgs rgba(239,83,80,.14)`
    - unit tag slots (light / dark text): `0 brs/#1D4ED8|#8AB0FF`, `1 vis/#5B3CC4|#A994FF`, `2 oks/#067A6A|#3CC7B4`, `3 wns/#8F5E12|#E5A93B`; company gets slot by its index in code-sorted list mod 4
    - type scale: title 28/34 600 −0.025em, heading 17/24 600, body 14/20 400, caption 12/16, overline 11/14 600 uppercase +0.07em; radius group 16, button 14, chip 18, badge 6
  - `ThemeProvider({ children })` with `useTheme(): { t: Tokens; mode: 'light'|'dark'|'auto'; scale: 1 | 1.15 }` (mode/scale from `src/prefs/device.ts`; auto follows `useColorScheme()`)
  - `src/prefs/device.ts`: `getDevicePrefs(): Promise<DevicePrefs>`, `setDevicePrefs(p: Partial<DevicePrefs>)`, `DevicePrefs { themeMode, textSize: 'normal'|'large', fingerprint: boolean }` in AsyncStorage key `tonnage.devicePrefs`
  - Components (props only; style from tokens, touch targets ≥ 44): `Badge({ kind: 'br'|'ok'|'wn'|'dg'|'nu'|'vi', children, dot?: boolean })`, `Button({ variant: 'primary'|'secondary'|'danger', onPress, disabled?, loading?, children })` (height 52), `SegmentedControl<T>({ options: { value: T; label: string }[]; value: T; onChange })`, `OtpInput({ length: 6, value, onChange, autoFocus? })`, `QtyText({ kg, withUnit? })` and `MoneyText({ rupees, short? })` reading unit basis from `useUnitBasis()` (Task 13; until then accept an optional `basis` prop defaulting to `'mt'`), `UnitTag({ code, slot })`, `Group`, `Row`, `Screen`, `Header({ title?, onBack? })`, `Chip({ label, count?, selected, onPress })`, `EmptyState({ title, body, actions })`, `Text({ variant })`. `Sheet`, `ProgressBar`, `Keypad` are deferred to the milestones that first use them.

- [ ] **Step 1: Configure Jest** (`jest-expo` preset, transformIgnorePatterns for `@tonnage/shared`), `babel.config.js` per Expo defaults, `app.json` name "Tonnage", slug `tonnage`, scheme `tonnage`, Android package `com.tonnage.app`, `userInterfaceStyle: automatic`.

- [ ] **Step 2: Write failing tests**

```ts
expect(lightTokens.bg).toBe('#F4F5F7'); expect(darkTokens.bg).toBe('#09090B');
expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(lightTokens).sort());
// ui.test.tsx
render(<QtyText kg={24180} basis="mt" withUnit />) → getByText('24.180 MT')
render(<QtyText kg={24180} basis="kg" withUnit />) → getByText('24,180 kg')
render(<MoneyText rupees={5580000} short />) → getByText('₹55.80 L')
OtpInput: typing '472' then '9' calls onChange('4729'); pasting '472915' fills all 6; non-digits ignored; length capped at 6
SegmentedControl: pressing 'kg' calls onChange('kg'); selected has accessibilityState { selected: true }
Button loading → disabled and onPress not called
ThemeProvider mode 'dark' → useTheme().t.bg === '#09090B'; textSize 'large' → scale 1.15
```

- [ ] **Step 3: Run — FAIL** (`pnpm --filter mobile test`).
- [ ] **Step 4: Implement.** Load Inter 400/500/600 in the root layout; `fontVariant: ['tabular-nums']` on numeric text.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `git commit -m "feat(mobile): Expo scaffold, canvas theme tokens, UI primitives"`

---

### Task 12: Mobile API client, session, sign-in, fingerprint lock

**Files:**
- Create: `src/api/client.ts`, `src/auth/session.ts`, `src/auth/lock.ts`, `app/_layout.tsx`, `app/(auth)/sign-in.tsx`, `app/(auth)/verify.tsx`, `app/lock.tsx`
- Test: `test/client.test.ts`, `test/lock.test.ts`, `test/sign-in.test.tsx`

**Interfaces:**
- Consumes: shared schemas (Task 3), auth endpoints (Task 6), UI (Task 11)
- Produces:
  - `api<T>(path: string, init?: { method?; body?; idempotent?: boolean; schema?: ZodType<T> }): Promise<T>` — base `process.env.EXPO_PUBLIC_API_URL`; adds `Authorization`; `idempotent` adds `Idempotency-Key` (`Crypto.randomUUID()`), reused across that call's retries; on 401 runs **one shared** refresh (single-flight promise) then retries once; refresh failure → `session.signOut()`; non-2xx → throws `ApiError { status, code, message, details }`; 90 s timeout; after 5 s pending sets `useNetStatus.waking = true` (banner "Waking server…").
  - `useSession` (Zustand): `{ status: 'loading'|'signedOut'|'signedIn'|'locked'; accessToken?: string; deviceId: string; signIn(pair): Promise<void>; signOut(): Promise<void>; lock(); unlock() }` — refresh token + deviceId persisted in SecureStore keys `tonnage.refresh`, `tonnage.device`.
  - `shouldLock(input: { enabled: boolean; lastActiveAt: number; now: number }): boolean` → `enabled && now - lastActiveAt >= 15 * 60_000`; `useIdleLock()` updates `lastActiveAt` on touches/foreground and locks on AppState `active` when `shouldLock`.
  - `needsForceUpdate(appVersion: string, minSupported: string): boolean` (semver compare, in `src/api/client.ts`); root layout calls `GET /v1/meta` on launch and, when true, renders a blocking "Update Tonnage" screen with a Play Store button (spec §9). Network failure on `/meta` never blocks the app.
  - Screens: sign-in (mobile input, "+91" prefix, `normalizeIndianMobile` validation inline, "Send code"), verify (masked number "+91 98260 ••345", `OtpInput`, resend countdown 30 s, "Unlock with fingerprint" toggle default on if hardware enrolled, "Verify and continue"); `TENANT_CHOICE_REQUIRED` shows a list of tenants and re-verifies with `tenantId`; lock screen calls `LocalAuthentication.authenticateAsync`, fallback "Sign in with code".

- [ ] **Step 1: Write failing tests**

```ts
// client.test.ts (fetch mocked)
it('two concurrent 401s trigger exactly one refresh, both retried with the new token', ...)
it('idempotent POST sends the same Idempotency-Key on its retry', ...)
it('error body maps to ApiError with code', ...)
it('refresh failure signs out', ...)
expect(needsForceUpdate('1.0.0', '1.0.1')).toBe(true);
expect(needsForceUpdate('1.2.0', '1.10.0')).toBe(true);   // numeric, not string, compare
expect(needsForceUpdate('1.10.0', '1.2.0')).toBe(false);
// lock.test.ts
expect(shouldLock({ enabled: true, lastActiveAt: 0, now: 15 * 60_000 })).toBe(true);
expect(shouldLock({ enabled: true, lastActiveAt: 0, now: 15 * 60_000 - 1 })).toBe(false);
expect(shouldLock({ enabled: false, lastActiveAt: 0, now: 10 ** 9 })).toBe(false);
// sign-in.test.tsx
it('invalid number disables Send code and shows "Enter a 10-digit mobile number"', ...)
it('OTP_INVALID shows "That code is not right. Try again."; OTP_LOCKED shows "Too many tries. Try again in 15 minutes."', ...)
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Manual check** — `pnpm dev:api`; in `apps/mobile` set `EXPO_PUBLIC_API_URL=http://<PC LAN IP>:3000` and run `npx expo start`; open in Expo Go on the phone; sign in as 9826100012 / 123456.
- [ ] **Step 6: Commit** — `git commit -m "feat(mobile): API client with refresh and idempotency, OTP sign-in, fingerprint lock"`

---

### Task 13: App shell — role tabs, unit basis, placeholders, More and Profile

**Files:**
- Create: `src/nav/tabs.ts`, `src/prefs/unit-basis.ts`, `src/api/hooks/me.ts`, `app/(app)/_layout.tsx`, `app/(app)/(tabs)/_layout.tsx`, tab screens `home.tsx, orders.tsx, new.tsx, dispatch.tsx, more.tsx, tasks.tsx, done.tsx, profile.tsx`, `src/ui/TabBar.tsx`, `src/ui/Placeholder.tsx`
- Test: `test/tabs.test.ts`, `test/unit-basis.test.tsx`, `test/shell.test.tsx`

**Interfaces:**
- Consumes: `/v1/me`, `PATCH /v1/me/preferences` (Task 9), session (Task 12)
- Produces:
  - `type TabKey = 'home'|'orders'|'new'|'dispatch'|'more'|'tasks'|'done'|'profile'`
  - `tabsForRole(role: Role): TabKey[]` — owner/city_staff `['home','orders','new','dispatch','more']`; plant_head `['home','orders','dispatch','more']`; supervisor `['tasks','done','profile']`
  - `useMe()` (TanStack Query key `['me']`, cached to AsyncStorage `tonnage.me` for offline start)
  - `useUnitBasis(): { basis: UnitBasis; setBasis(b: UnitBasis): Promise<void> }` — reads `me.preferences.unitBasis`; `setBasis` PATCHes and updates the `['me']` cache; `QtyText`/`MoneyText` now default to it
  - Tab bar matches canvas: 80 px, active pill `brs`/`brt`, "New" filled `inv` square-ish (radius 12); labels Home, Orders, New, Dispatch, More / My tasks, Done, Profile; icons inline SVG (`react-native-svg` via `npx expo install react-native-svg`) copied from the canvas paths
  - Screens not built in M1 (Home, Orders, New, Dispatch, My tasks, Done) render `Placeholder` with the tab name and "Arrives in M2" / "M3"
  - More (canvas "More menu", admin rows only for owner via `can(role,'users.manage')`): profile card (initials, name, role label "Owner · all 4 units · +91 98261 00012"), Admin: Companies & units, Users & roles, Settings; Sign out. Masters/Money rows render disabled with "Coming soon".
  - Profile (supervisor): name, plant, Units segmented control, Sign out.

- [ ] **Step 1: Write failing tests**

```ts
expect(tabsForRole('supervisor')).toEqual(['tasks','done','profile']);
expect(tabsForRole('plant_head')).not.toContain('new');
// shell.test.tsx with mocked useMe
it('supervisor sees My tasks / Done / Profile and no Orders tab', ...)
it('city_staff More hides Companies & units and Users & roles', ...)
it('deep link to /users as supervisor redirects to /tasks', ...)
// unit-basis.test.tsx
it('switching to kg re-renders QtyText 24180 from "24.180 MT" to "24,180 kg" and PATCHes once', ...)
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Manual check** in Expo Go: sign in as owner (9826100012) → 5 tabs; as Ravi (9826100014) → 3 tabs; switch Units on Profile and reopen app → still kg.
- [ ] **Step 6: Commit** — `git commit -m "feat(mobile): role-based app shell, unit basis preference, More and Profile"`

---

### Task 14: Mobile admin — Companies & units, Users & roles, Invite, Settings

**Files:**
- Create: `src/api/hooks/{companies,plants,users,settings}.ts`, `app/(app)/companies/index.tsx`, `app/(app)/companies/[id].tsx`, `app/(app)/users/index.tsx`, `app/(app)/users/invite.tsx`, `app/(app)/users/[id].tsx`, `app/(app)/settings.tsx`
- Test: `test/invite.test.tsx`, `test/settings.test.tsx`, `test/companies.test.tsx`

**Interfaces:**
- Consumes: Task 8 and Task 9 endpoints, `describeRole`, `plantRule` (Task 2), UI (Task 11)
- Produces screens matching the canvas artboards "Companies & units", "Users & roles", "Invite user", "Settings":
  - Companies list: code tag, name, Active badge, "Siltara, Raipur · GSTIN …", plants; add/edit company (code, name, GSTIN with `gstinSchema`, order prefix) and plants; `STALE` → toast "Someone else changed this. Showing the latest." and refetch.
  - Users list: initials, name, scope line ("All units" or plant names), role badge, Invited badge; Roles tab shows `describeRole` for each role.
  - Invite: name, mobile (+91), role radio (Owner · admin, City staff / Accounts, Plant head, Loading supervisor), plant picker obeying `plantRule` (single-select for supervisor, multi for plant head, hidden otherwise), live "{name} will be able to ✓ … ✕ …" from `describeRole` with `{plant}` filled; submit → `POST /v1/users` with idempotency; `MOBILE_EXISTS` inline on the mobile field. Button copy "Send invite" (WhatsApp delivery is out of M1).
  - User detail: change role/plants, deactivate/reactivate; `LAST_OWNER` → "You can't remove the last owner."
  - Settings: Appearance (Theme Light/Dark/Auto, Text size Normal/Large — device prefs), **Units: MT / ₹ per MT · kg / ₹ per kg** (`useUnitBasis`), Orders & dispatch (owner only: completion tolerance shown via `toDisplayQty` in current basis and edited via `parseQtyInput`, aged-order days, default pricing), Security (fingerprint toggle), app version footer "Tonnage v1.0.0 · Android".

- [ ] **Step 1: Write failing tests**

```ts
it('invite: choosing Loading supervisor shows single plant picker; submit disabled until one plant chosen', ...)
it('invite: preview shows "✓ See trucks assigned to Nandan · Tilda" after picking Tilda', ...)
it('invite: MOBILE_EXISTS error renders under the mobile field', ...)
it('settings: tolerance shows "1.000" with MT and "1,000" with kg; entering 0.5 in MT PATCHes completionToleranceKg 500', ...)
it('settings: city_staff does not see Orders & dispatch section', ...)
it('companies: invalid GSTIN shows "Enter a valid 15-character GSTIN"', ...)
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Manual check** in Expo Go as owner: add a plant to KRM, invite a supervisor for Tilda, switch to Graphite dark and Large text.
- [ ] **Step 6: Commit** — `git commit -m "feat(mobile): companies, users and invite, settings screens"`

---

### Task 15: CLAUDE.md, README, end-to-end verification

**Files:**
- Create: `CLAUDE.md` (starts with the required header: `# CLAUDE.md` / `This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.`), `README.md`
- Modify: `.github/workflows/ci.yml` if any script names changed

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `CLAUDE.md`** — commands (install, `pnpm dev:db`, `db:migrate`, `db:seed`, `dev:api`, `npx expo start` in `apps/mobile`, `pnpm test`, single test: `pnpm --filter @tonnage/api exec vitest run test/users.test.ts -t "LAST_OWNER"` and `pnpm --filter mobile exec jest test/tabs.test.ts`), architecture big picture (shared rules used by both sides; two DB roles + RLS + `withTenant`; route `action` + policy + scope + redaction + idempotency pipeline; integer kg/₹ and unit basis display-only; Expo Go constraint), pointers to the spec, the decisions doc and canvas links, dev OTP `123456` and seeded numbers.
- [ ] **Step 2: Write `README.md`** — setup on Windows (corepack, no Docker needed), running on a phone with Expo Go over LAN.
- [ ] **Step 3: Full verification** — Run: `pnpm lint && pnpm typecheck && pnpm test` → all green. Push branch and confirm CI green (requires a GitHub remote; if none, note it).
- [ ] **Step 4: Commit** — `git commit -m "docs: CLAUDE.md and README for M1"`
