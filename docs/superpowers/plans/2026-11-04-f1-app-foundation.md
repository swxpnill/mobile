# F1 App Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running monorepo where a seeded user signs in with the dev OTP on an Android phone (Expo Go), lands on the tab set for their role, picks MT or kg app-wide, and an owner manages companies, plants, users and tenant settings — all against an in-app mock API that enforces the same contract (schemas, policy, plant scope, money redaction, idempotency, error codes) the real backend will, proven by a contract-test suite.

**Architecture:** pnpm monorepo. `packages/shared` holds pure TypeScript used everywhere (units, formatters, mobile normalisation, roles, `policy.ts`, `redactForRole`, error codes, settings, zod schemas, the `Transport` interface, the canvas sample-world fixture). `packages/mock-api` implements the §7 REST contract in-process over an in-memory store. `packages/contract-tests` is an HTTP-level suite written against `Transport`, run now against the mock and in B1 against the real API. `apps/mobile` is Expo + Expo Router + TanStack Query, styled from the canvas tokens, talking only to a `Transport`.

**Tech Stack:** Node 22, pnpm (corepack), TypeScript 5 strict, zod, Vitest, fast-check, Expo (latest SDK) + Expo Router, TanStack Query, Zustand, react-hook-form, expo-secure-store, @react-native-async-storage/async-storage, expo-local-authentication, expo-crypto, react-native-svg, @expo-google-fonts/inter, jest-expo + @testing-library/react-native, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md` (read §2, §4 Organisation & access, §5.5, §5.6, §5.7, §7 incl. **§7.1 Mock API**, §8.1, §8.2, §8.4, §9, §10, §12).

**Follow-on:** `docs/superpowers/plans/2026-11-04-b1-api-foundation.md` builds the real API for this same contract (run after F1–F5).

## Global Constraints

- The mobile app talks to the backend **only** through `Transport` (`packages/shared/src/transport.ts`); `EXPO_PUBLIC_API_MODE = mock | http`, default `mock`.
- `packages/mock-api` and `packages/shared` import nothing from React Native or Expo.
- Mock handlers validate with the shared zod schemas, authorise with `policy.ts` + plant scope, redact with `redactForRole`, and return the spec's error bodies `{ code, message, details? }`; out-of-scope records return 404, never 403.
- Every route declares `action` unless `public: true`; a route without either throws when the router is built.
- Quantities are integer kg; money is integer rupees; rates are whole ₹ per MT. No floats in stored values or arithmetic on them.
- Business time zone `Asia/Kolkata`.
- Roles: `owner | city_staff | plant_head | supervisor`. Supervisor has exactly 1 plant; plant head ≥ 1; owner and city staff have none (see all).
- Unit basis `mt | kg`, default `mt`, per user (`preferences.unitBasis`), app-wide, display/input only. MT shows 3 decimals; kg whole numbers; ₹/kg input up to 3 decimals; ₹/MT whole rupees.
- Tenant settings defaults: `completionToleranceKg: 1000`, `agedOrderDays: 10`, `defaultPricing: 'basic_conversion'`, `allowHardDeleteAfterDispatch: true`, `externalUnitBasis: 'mt'`, `orderNumberFormat: 'SO-YYMM-0001'`.
- Access token 15 min; refresh token 60 days rolling, rotated on use, 30 s grace for an identical retry, reuse after grace revokes all of that user's tokens; revoked on deactivation.
- OTP: 6 digits, dev code `123456`, 5-minute expiry, 5 wrong attempts → number locked 15 min, resend allowed after 30 s; request-code never reveals whether a number exists.
- Mutating create routes require `Idempotency-Key`; replay returns the stored response with header `Idempotent-Replay: true`.
- Money keys are omitted (not null) for `plant_head` and `supervisor`.
- Fingerprint lock after 15 min idle.
- Mobile must run in **Expo Go** (no custom native modules).
- Copy and colours come from the canvas; theme tokens exactly as in Task 6.
- Windows dev machine: scripts must work in Git Bash and PowerShell (no `rm -rf`, no `export X=`).

## Review Focus

1. **Owner deactivates themself or demotes the last active owner** → refused with `409 LAST_OWNER`; a tenant is never left without an owner. (Task 5 contract `users`)
2. **Mobile typed in different shapes** (`+91 98260 12345`, `9826012345`, `09826012345`, `919826012345`) → all resolve to `+919826012345`, the same user; `12345` or `5826012345` rejected. (Tasks 2, 5)
3. **Refresh sent twice with the same token** (retry on flaky network) → second call within 30 s returns the same new pair; reuse after 30 s returns 401 and revokes every token of that user. (Task 5 contract `auth`)
4. **Deactivated user still holding a valid access token** → next request `401 UNAUTHENTICATED`. (Task 5 contract `pipeline`)
5. **Guessing another tenant's or another plant's record id** → `404 NOT_FOUND`, identical to a missing id. (Task 5 contract `org`)

---

## File Structure

```
package.json, pnpm-workspace.yaml, .npmrc (node-linker=hoisted), tsconfig.base.json,
eslint.config.mjs, .prettierrc, .github/workflows/ci.yml, CLAUDE.md, README.md

packages/shared/src/
  units.ts, format.ts, mobile.ts, roles.ts, policy.ts, redact.ts, errors.ts, settings.ts,
  transport.ts, fixtures/sample-world.ts, schemas/{auth,me,org,users}.ts, index.ts

packages/mock-api/src/
  index.ts        createMockApi()
  router.ts       route table, path params, query parsing, route config checks
  pipeline.ts     auth → policy → scope → handler → redaction → idempotency
  store.ts        MockState type, seed from fixture, snapshot/restore
  clock.ts        injectable clock
  handlers/{auth,me,meta,companies,plants,users,settings}.ts
  controls.ts     demo controls (offline, latency, failNext, signInAs, reset)

packages/contract-tests/src/
  harness.ts      ContractTarget type, call() helper
  suites/{auth,me,org,users,settings,pipeline}.contract.ts
  mock.test.ts    runs every suite against createMockApi()

apps/mobile/
  app/_layout.tsx, app/(auth)/{sign-in,verify}.tsx, app/lock.tsx, app/update.tsx,
  app/(app)/_layout.tsx, app/(app)/(tabs)/_layout.tsx + tab screens,
  app/(app)/companies/*, app/(app)/users/*, app/(app)/settings.tsx, app/(app)/demo-tools.tsx
  src/theme/{tokens,ThemeProvider}.ts(x), src/ui/*.tsx,
  src/api/{transport,client}.ts, src/api/hooks/*.ts,
  src/auth/{session,lock}.ts, src/nav/tabs.ts, src/prefs/{unit-basis,device}.ts
  test/*.test.ts(x)
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

On push/PR: checkout, setup-node 22, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. (A Postgres service is added in B1.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold, CI, shared unit-basis conversions"
```

---

### Task 2: Shared formatters, mobile normalisation, roles, policy, errors, settings

**Files:**
- Create: `packages/shared/src/format.ts` (extend), `mobile.ts`, `roles.ts`, `policy.ts`, `redact.ts`, `errors.ts`, `settings.ts`
- Test: `format.test.ts`, `mobile.test.ts`, `policy.test.ts`, `redact.test.ts`, `settings.test.ts`

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
  - `redactForRole(role: Role, payload: unknown): unknown` — deep-walk objects and arrays; for `plant_head`/`supervisor` omit every key in `MONEY_KEYS` at any depth; other roles get the payload unchanged; never mutates its input
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
// redact.test.ts
const p = { id: 'o1', qtyKg: 24180, rate: 46300, lines: [{ amount: 5, x: 1 }], nested: { due: 9 } };
expect(redactForRole('supervisor', p)).toEqual({ id: 'o1', qtyKg: 24180, lines: [{ x: 1 }], nested: {} });
expect(redactForRole('plant_head', p)).toEqual(redactForRole('supervisor', p));
expect(redactForRole('owner', p)).toEqual(p);
redactForRole('supervisor', p); expect(p.rate).toBe(46300); // input untouched
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

### Task 4: `packages/mock-api` — in-process implementation of the M1 contract

**Files:**
- Create: `packages/shared/src/transport.ts`, `packages/shared/src/fixtures/sample-world.ts` (export both from `index.ts`)
- Create: `packages/mock-api/package.json` (`@tonnage/mock-api`, depends on `@tonnage/shared`, `uuid`), `tsconfig.json`, `vitest.config.ts`
- Create: `packages/mock-api/src/{index,router,pipeline,store,clock,controls}.ts`, `src/handlers/{auth,me,meta,companies,plants,users,settings}.ts`
- Test: `packages/mock-api/src/router.test.ts`, `src/store.test.ts`, `src/controls.test.ts`

Behavioural coverage of the endpoints lives in Task 5's contract suite; this task's own tests cover only what the contract cannot see (router construction, persistence, controls).

**Interfaces:**
- Consumes: everything in Tasks 1–3.
- Produces (in `@tonnage/shared`):
  - `type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'`
  - `interface TransportRequest { method: HttpMethod; path: string; headers: Record<string, string>; body?: unknown }` (path includes query string, e.g. `/v1/plants?companyId=…`; header names lower-case)
  - `interface TransportResponse { status: number; headers: Record<string, string>; body: unknown }`
  - `interface Transport { request(req: TransportRequest): Promise<TransportResponse> }` — a network failure rejects with `NetworkError` (exported class, `name = 'NetworkError'`)
  - `SAMPLE_WORLD` — the canvas sample world as plain data: tenant "Agrawal Group"; companies `AIP` Aarav Ispat Pvt Ltd (GSTIN 22AAJCA4410K1ZQ, prefix SO-AIP, plant Siltara · Raipur), `VSL` Vrinda Steels LLP (22AAKFV2093P1ZC, Urla · Raipur), `KRM` Kalinga Rolling Mills (22AADFK7781M1Z2, Borai · Durg), `NAP` Nandan Alloys Pvt Ltd (22AAHCN6620Q1Z7, Tilda · Raipur); users Rajesh Agrawal owner +919826100012, Priya Sharma city_staff +919826100013, Amit Verma city_staff +919425067890, Ravi Verma supervisor Siltara +919826100014, Sanjay Patel supervisor Borai +919826100015, Mohan Kurre supervisor Urla +919826100016, Deepak Sahu supervisor Tilda +919826100017 (invited, never seen), Kiran Rao plant_head Siltara +919826100018. Stable hard-coded UUIDs so tests and the B1 seed can refer to them.
- Produces (in `@tonnage/mock-api`):
  - `interface StorageAdapter { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }`
  - `createMockApi(opts?: { storage?: StorageAdapter; clock?: Clock; latencyMs?: number; storageKey?: string }): Promise<MockApi>`
  - `interface MockApi { transport: Transport; controls: MockControls; fixtures: MockFixtures }`
  - `interface MockControls { reset(): Promise<void>; setOffline(on: boolean): void; setLatency(ms: number): void; failNext(status: number, code: ErrorCode): void; signInAs(userId: string, deviceId: string): Promise<TokenPair> }`
  - `interface MockFixtures { createTenant(name: string): Promise<{ tenantId: string; ownerMobile: string; companyId: string; plantId: string }> }` (used by contract tests for cross-tenant cases)
  - `interface Clock { now(): number }`, `systemClock`, `createFakeClock(start: number): Clock & { advance(ms: number): void }`
  - Route definition (internal, mirrors B1's Fastify route config): `route(method, pattern, { public?: true; action?: Action; idempotent?: true; body?: ZodTypeAny; query?: ZodTypeAny; handler(ctx): Promise<{ status?: number; body?: unknown; headers?: Record<string,string> }> })`; `ctx = { user?, params, query, body, state, now, scope }`

- [ ] **Step 1: Write failing tests**

```ts
// router.test.ts
it('throws when a route has neither action nor public', () => expect(() => buildRouter([{ method: 'GET', pattern: '/v1/x', handler }])).toThrow(/must declare action/));
it('matches path params and parses query', ...)   // '/v1/plants/:id?x=1' → params.id, query.x
it('unknown route → 404 { code: "NOT_FOUND" }', ...)
// store.test.ts
it('seeds SAMPLE_WORLD: 4 companies, 4 plants, 8 users', ...)
it('persists after a mutating request and restores on next createMockApi with the same storage', ...)
it('reset() restores the seed and clears sessions', ...)
it('corrupt snapshot in storage falls back to the seed instead of crashing', ...)
// controls.test.ts
it('setOffline(true) → transport rejects with NetworkError; false → works again', ...)
it('failNext(503, "INTERNAL") affects exactly one request', ...)
it('latency delays responses by the configured ms (fake timers)', ...)
it('signInAs returns a token pair usable on GET /v1/me', ...)
```

- [ ] **Step 2: Run — FAIL.** Run: `pnpm --filter @tonnage/mock-api test`

- [ ] **Step 3: Implement**

Pipeline order per request (mirror exactly what B1's Fastify app does, so the contract matches):
1. offline/latency/failNext controls;
2. route match (404 if none); parse query and body with the route's zod schemas (422 `VALIDATION`, `details` = zod issues `{ path, message }[]`);
3. unless `public`: bearer token → session → user; missing/expired/unknown token or inactive user → 401 `UNAUTHENTICATED`;
4. `can(user.role, action)` else 403 `FORBIDDEN`;
5. idempotent routes: require `idempotency-key` (400 `IDEMPOTENCY_KEY_REQUIRED`); replay stored `(userId, key)` → stored status/body + `idempotent-replay: true`; same key on a different route → 422 `VALIDATION`;
6. handler, with `ctx.scope = plantScope(user)` and every lookup filtered by `tenantId` and scope (out of scope → 404);
7. `redactForRole(user.role, body)`;
8. persist snapshot (debounced 250 ms) on non-GET 2xx.

Handlers implement, with the business rules in the Global Constraints and these specifics:
- `auth`: request-code (always `200 { resendAfterSeconds: 30 }`; 429 `OTP_RESEND_TOO_SOON` if < 30 s since last challenge for that mobile; 429 `OTP_LOCKED` while locked), verify (code `123456`; wrong → 401 `OTP_INVALID`; 5th wrong locks 15 min → 429 `OTP_LOCKED`; > 5 min → 401 `OTP_EXPIRED`; consumed → 401 `OTP_INVALID`; inactive user → 401 `OTP_INVALID`; mobile in > 1 tenant without `tenantId` → 409 `TENANT_CHOICE_REQUIRED` `details: [{ tenantId, tenantName }]`; success sets `lastSeenAt`), refresh (rotation, device binding, 30 s grace, reuse revoke-all, 60-day rolling expiry), sign-out (204).
- `me`: GET, PATCH preferences.
- `meta`: `{ minSupportedVersion: '1.0.0', serverTime }`.
- `companies`, `plants`: list/create/patch with `version` (409 `STALE`), unique company `code` per tenant (422 `VALIDATION` path `['code']`), supervisors/plant heads list only companies/plants in scope; `assertCompanyDeactivatable` no-op hook (F2 extends).
- `users`: list (status active/invited/inactive), invite (`PLANT_RULE`, `MOBILE_EXISTS`), patch (role change re-validates plants; clears plants for owner/city_staff), deactivate (revokes tokens; `LAST_OWNER`), reactivate.
- `settings`: GET (`self.view`), PATCH (`settings.manage`, merged then validated).
- Every write appends to `state.activity` with the same action names as spec (`company.created`, `user.invited`, …).

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(mock-api): in-process M1 contract with persistence and demo controls"`

---

### Task 5: `packages/contract-tests` — the M1 contract suite, green on the mock

**Files:**
- Create: `packages/contract-tests/package.json` (`@tonnage/contract-tests`), `vitest.config.ts`, `src/harness.ts`, `src/suites/{auth,me,org,users,settings,pipeline}.contract.ts`, `src/mock.test.ts`

**Interfaces:**
- Consumes: `Transport`, schemas, `SAMPLE_WORLD` (Tasks 3–4), `createMockApi`, `createFakeClock`
- Produces:
  - `interface ContractTarget { transport: Transport; reset(): Promise<void>; clock: { advance(ms: number): void }; fixtures: MockFixtures; capabilities: { concurrency: boolean } }`
  - `type TargetFactory = () => Promise<ContractTarget>`
  - `call(t: ContractTarget, method: HttpMethod, path: string, opts?: { token?: string; body?: unknown; idempotencyKey?: string }): Promise<TransportResponse>`
  - `signIn(t, mobile: string, deviceId?: string): Promise<TokenPair>` (request-code + verify `123456`)
  - Each suite file exports `register(factory: TargetFactory): void` that declares a `describe` block; `src/index.ts` exports `registerAll(factory)`. B1 calls `registerAll` with a Fastify-backed factory.

- [ ] **Step 1: Write the suites** (they are the tests; each case is one `it`)

```ts
// auth.contract.ts
'request-code: same 200 { resendAfterSeconds: 30 } for known and unknown numbers'
'verify 123456 → token pair; GET /v1/me with it → Rajesh, role owner'
'wrong code → 401 OTP_INVALID; 5 wrong → 429 OTP_LOCKED even for 123456; after clock.advance(15 min) works'
'challenge older than 5 min → 401 OTP_EXPIRED'
'resend within 30 s → 429 OTP_RESEND_TOO_SOON'
'consumed code reused → 401 OTP_INVALID'
'deactivated user → verify 401 OTP_INVALID'
'mobile in two tenants → 409 TENANT_CHOICE_REQUIRED with both tenant names; with tenantId → 200'
'refresh rotates; old token then 401 after 30 s'
'Review Focus 3: same old refresh twice within 30 s → identical new pair'
'Review Focus 3: reuse after grace → 401 and the newer refresh token is also revoked'
'refresh from a different deviceId → 401'
'access token rejected after clock.advance(15 min) → 401 UNAUTHENTICATED; refresh still works'
// pipeline.contract.ts
'no token → 401 UNAUTHENTICATED with body { code, message }'
'Review Focus 4: deactivate Priya, her existing access token → 401 on next request'
'supervisor GET /v1/users → 403 FORBIDDEN'
'idempotent POST /v1/plants replayed with same key → same body, header idempotent-replay: true, only one plant created'
'idempotent POST without key → 400 IDEMPOTENCY_KEY_REQUIRED'
'two concurrent same-key POSTs → one 2xx, one 409 IDEMPOTENCY_IN_PROGRESS' (it.skipIf(!t.capabilities.concurrency))
'unknown route → 404 NOT_FOUND'
// org.contract.ts
'owner lists 4 companies; Ravi (supervisor) lists only AIP; Kiran (plant head) lists only AIP'
'create company duplicate code → 422 VALIDATION details[0].path = ["code"]'
'PATCH stale version → 409 STALE; success returns version + 1'
'Review Focus 5: another tenant’s company id → GET/PATCH 404 NOT_FOUND, same body as a random uuid'
'Ravi GET /v1/plants?companyId=<KRM> → [] ; GET /v1/plants/<Borai> → 404'
'city_staff POST /v1/companies → 403'
'deactivate a company with no orders → 200 active false'
// users.contract.ts
'invite supervisor with 1 plant → 201 status invited; 0 or 2 plants → 422 PLANT_RULE'
'plant_head 2 plants ok; city_staff with a plant → 422 PLANT_RULE'
'Review Focus 2: invite "09826100013" (Priya exists) → 409 MOBILE_EXISTS; invite "+91 98261 00099" stored as "+919826100099"'
'change Ravi supervisor → city_staff with plantIds [] → plants cleared, his tabs data now all companies'
'plantIds from another tenant → 404'
'Review Focus 1: Rajesh deactivates himself → 409 LAST_OWNER; demote Rajesh → 409 LAST_OWNER; after inviting a second owner, both allowed'
'Deepak status invited; after he signs in → active'
// me.contract.ts
'GET /v1/me shape matches meSchema; default unitBasis "mt"'
'PATCH /v1/me/preferences { unitBasis: "kg" } persists across sign-in; "lb" → 422'
// settings.contract.ts
'new tenant settings equal DEFAULT_TENANT_SETTINGS'
'owner PATCH { completionToleranceKg: 500 } → GET returns 500; { externalUnitBasis: "lb" } → 422; city_staff PATCH → 403; supervisor GET → 200'
```

Every response body is also parsed with its shared zod response schema, so shape drift fails the suite.

- [ ] **Step 2: `src/mock.test.ts`** — `registerAll(async () => { const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30)); const m = await createMockApi({ clock }); return { transport: m.transport, reset: m.controls.reset, clock, fixtures: m.fixtures, capabilities: { concurrency: false } }; })`

- [ ] **Step 3: Run** — `pnpm --filter @tonnage/contract-tests test`. Expected: all pass (concurrency case skipped). Any failure is a bug in `mock-api` (Task 4) — fix there, not in the suite, unless the suite contradicts the spec.

- [ ] **Step 4: Commit** — `git commit -m "test(contract): M1 contract suite running against mock-api"`

---

### Task 6: Mobile scaffold, theme tokens, UI primitives

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
  - Components (props only; style from tokens, touch targets ≥ 44): `Badge({ kind: 'br'|'ok'|'wn'|'dg'|'nu'|'vi', children, dot?: boolean })`, `Button({ variant: 'primary'|'secondary'|'danger', onPress, disabled?, loading?, children })` (height 52), `SegmentedControl<T>({ options: { value: T; label: string }[]; value: T; onChange })`, `OtpInput({ length: 6, value, onChange, autoFocus? })`, `QtyText({ kg, withUnit? })` and `MoneyText({ rupees, short? })` reading unit basis from `useUnitBasis()` (Task 8; until then accept an optional `basis` prop defaulting to `'mt'`), `UnitTag({ code, slot })`, `Group`, `Row`, `Screen`, `Header({ title?, onBack? })`, `Chip({ label, count?, selected, onPress })`, `EmptyState({ title, body, actions })`, `Text({ variant })`. `Sheet`, `ProgressBar`, `Keypad` are deferred to the milestones that first use them.

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

### Task 7: Mobile API client, session, sign-in, fingerprint lock

**Files:**
- Create: `src/api/transport.ts`, `src/api/client.ts`, `src/auth/session.ts`, `src/auth/lock.ts`, `app/_layout.tsx`, `app/(auth)/sign-in.tsx`, `app/(auth)/verify.tsx`, `app/lock.tsx`
- Test: `test/client.test.ts`, `test/lock.test.ts`, `test/sign-in.test.tsx`

**Interfaces:**
- Consumes: shared schemas (Task 3), auth endpoints via mock-api (Task 4), UI (Task 6)
- Produces:
  - `src/api/transport.ts`: `API_MODE: 'mock' | 'http'` from `EXPO_PUBLIC_API_MODE` (default `mock`); `getTransport(): Promise<Transport>` — mock: a singleton `createMockApi({ storage: AsyncStorage })`; http: `createHttpTransport(baseUrl = process.env.EXPO_PUBLIC_API_URL)` wrapping `fetch` and converting fetch rejections to `NetworkError`
  - `api<T>(path: string, init?: { method?; body?; idempotent?: boolean; schema?: ZodType<T> }): Promise<T>` — sends through `getTransport()`; adds `Authorization`; `idempotent` adds `Idempotency-Key` (`Crypto.randomUUID()`), reused across that call's retries; on 401 runs **one shared** refresh (single-flight promise) then retries once; refresh failure → `session.signOut()`; non-2xx → throws `ApiError { status, code, message, details }`; 90 s timeout; after 5 s pending sets `useNetStatus.waking = true` (banner "Waking server…").
  - `useSession` (Zustand): `{ status: 'loading'|'signedOut'|'signedIn'|'locked'; accessToken?: string; deviceId: string; signIn(pair): Promise<void>; signOut(): Promise<void>; lock(); unlock() }` — refresh token + deviceId persisted in SecureStore keys `tonnage.refresh`, `tonnage.device`.
  - `shouldLock(input: { enabled: boolean; lastActiveAt: number; now: number }): boolean` → `enabled && now - lastActiveAt >= 15 * 60_000`; `useIdleLock()` updates `lastActiveAt` on touches/foreground and locks on AppState `active` when `shouldLock`.
  - `needsForceUpdate(appVersion: string, minSupported: string): boolean` (semver compare, in `src/api/client.ts`); root layout calls `GET /v1/meta` on launch and, when true, renders a blocking "Update Tonnage" screen with a Play Store button (spec §9). Network failure on `/meta` never blocks the app.
  - Screens: sign-in (mobile input, "+91" prefix, `normalizeIndianMobile` validation inline, "Send code"), verify (masked number "+91 98260 ••345", `OtpInput`, resend countdown 30 s, "Unlock with fingerprint" toggle default on if hardware enrolled, "Verify and continue"); `TENANT_CHOICE_REQUIRED` shows a list of tenants and re-verifies with `tenantId`; lock screen calls `LocalAuthentication.authenticateAsync`, fallback "Sign in with code".

- [ ] **Step 1: Write failing tests**

```ts
// client.test.ts — against createMockApi with a fake clock (no fetch mocks); http transport tested separately with a stubbed fetch
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
- [ ] **Step 5: Manual check** — `cd apps/mobile && npx expo start` (mock mode); open in Expo Go on the phone; sign in as 9826100012 / 123456.
- [ ] **Step 6: Commit** — `git commit -m "feat(mobile): API client with refresh and idempotency, OTP sign-in, fingerprint lock"`

---

### Task 8: App shell — role tabs, unit basis, placeholders, More and Profile

**Files:**
- Create: `src/nav/tabs.ts`, `src/prefs/unit-basis.ts`, `src/api/hooks/me.ts`, `app/(app)/_layout.tsx`, `app/(app)/(tabs)/_layout.tsx`, tab screens `home.tsx, orders.tsx, new.tsx, dispatch.tsx, more.tsx, tasks.tsx, done.tsx, profile.tsx`, `src/ui/TabBar.tsx`, `src/ui/Placeholder.tsx`
- Test: `test/tabs.test.ts`, `test/unit-basis.test.tsx`, `test/shell.test.tsx`

**Interfaces:**
- Consumes: `/v1/me`, `PATCH /v1/me/preferences` (mock-api, Task 4), session (Task 7)
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

### Task 9: Mobile admin — Companies & units, Users & roles, Invite, Settings

**Files:**
- Create: `src/api/hooks/{companies,plants,users,settings}.ts`, `app/(app)/companies/index.tsx`, `app/(app)/companies/[id].tsx`, `app/(app)/users/index.tsx`, `app/(app)/users/invite.tsx`, `app/(app)/users/[id].tsx`, `app/(app)/settings.tsx`
- Test: `test/invite.test.tsx`, `test/settings.test.tsx`, `test/companies.test.tsx`

**Interfaces:**
- Consumes: companies, plants, users, settings endpoints (mock-api, Task 4), `describeRole`, `plantRule` (Task 2), UI (Task 6)
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

### Task 10: Demo tools

**Files:**
- Create: `apps/mobile/app/(app)/demo-tools.tsx`, `apps/mobile/src/api/demo.ts`
- Modify: `apps/mobile/app/(app)/(tabs)/more.tsx`, `profile.tsx` (entry row)
- Test: `apps/mobile/test/demo-tools.test.tsx`

**Interfaces:**
- Consumes: `MockControls` (Task 4), `useSession` (Task 7), `SAMPLE_WORLD`
- Produces:
  - `demoToolsEnabled(): boolean` → `API_MODE === 'mock' && (__DEV__ || process.env.EXPO_PUBLIC_DEMO_TOOLS === '1')`
  - `getMockControls(): MockControls | null` (null in http mode)
  - Screen sections: **Sign in as** (one row per `SAMPLE_WORLD` user with role badge → `controls.signInAs` → `session.signIn` → router replace to that role's first tab), **Network** (Offline switch; Latency segmented 0 / 800 ms / 6 s), **Next request fails with** (picker of `STALE`, `INTERNAL` 500, `FORBIDDEN`, `NETWORK`), **Reset demo data** (confirm sheet, then `controls.reset()` + sign out).

- [ ] **Step 1: Write failing tests**

```ts
it('row hidden when demoToolsEnabled() is false', ...)
it('Sign in as Ravi Verma lands on My tasks', ...)
it('Offline on → next screen fetch shows the network error state; off → retry succeeds', ...)
it('Latency 6 s shows the "Waking server…" banner after 5 s', ...)
it('Reset demo data restores 4 companies after one was added', ...)
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): demo tools for mock mode"`

---

### Task 11: CLAUDE.md, README, end-to-end verification

**Files:**
- Create: `CLAUDE.md` (must start with `# CLAUDE.md` then the line `This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.`), `README.md`

- [ ] **Step 1: Write `CLAUDE.md`**: commands (`corepack enable`, `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`; single tests: `pnpm --filter @tonnage/shared exec vitest run src/units.test.ts`, `pnpm --filter @tonnage/contract-tests exec vitest run -t "LAST_OWNER"`, `pnpm --filter mobile exec jest test/tabs.test.ts`; run app: `cd apps/mobile && npx expo start`, open in Expo Go), architecture big picture (frontend-first: app → `Transport` → `mock-api` now, real API in B-milestones; shared schemas/rules/policy/redaction used by both; contract suite is the definition of done for both backends; integer kg/₹ with display-only unit basis; Expo Go constraint), dev sign-in (`123456`, seeded numbers from `SAMPLE_WORLD`), Demo tools, pointers to the spec, plans, decisions doc and canvas links.
- [ ] **Step 2: Write `README.md`**: Windows setup (corepack; no Docker needed in F-milestones), running on a phone with Expo Go over LAN.
- [ ] **Step 3: Full verification** — Run: `pnpm lint && pnpm typecheck && pnpm test` → all green. On the phone: sign in as owner, add a plant, invite a supervisor, switch to kg and Graphite dark, use Demo tools to sign in as Ravi and see 3 tabs.
- [ ] **Step 4: Commit** — `git commit -m "docs: CLAUDE.md and README for F1"`
