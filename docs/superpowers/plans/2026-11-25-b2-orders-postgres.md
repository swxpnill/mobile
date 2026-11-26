# B2 Orders on Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real API serves masters (parties, products) and orders (create, list, detail, drafts, duplicate, Home, edit, short close, reopen, move quantity, delete, activity) on Postgres. It passes the contract suites `masters`, `orders` and `order-lifecycle` that the mock passes, and adds the database guarantees the mock cannot give: numbers issued under row lock, version races, real concurrency.

**Architecture:** The B1 foundation stays as it is: `defineRoute`, one transaction per request, RLS applied to every `tenant_id` table, the clock, redaction and idempotency. New tables come in two forward-only migrations: masters, then orders. The trucks table is created in its final shape now, because order views read trucks and short close cancels them. Truck routes, weighments, sync, rejections and tombstones stay in B3. Derived figures (pending, status, totals, value) are computed in TypeScript from rows loaded per request, using the pure rules in `packages/shared/src/rules/`, exactly as the mock does. The server and the mock therefore share one implementation of the business maths.

**Tech Stack:** as in B1: Fastify 5, Drizzle + drizzle-kit, `pg`, zod, Vitest, embedded Postgres 16 locally and `postgres:16` in CI.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md`:
- §4: masters and orders tables, `number_series`;
- §5.1–5.4: quantities, derived status, lifecycle, pricing;
- §5.7: concurrency;
- §10.1: the permission matrix, serializer leak and concurrency tests.

Behaviour is defined by the reference mock (`packages/mock-api/src/handlers/{parties,products,orders,drafts,home,order-lifecycle}.ts`, `order-views.ts`, `orders-math.ts`) and by the contract suites. Where they disagree with this plan, the contract decides.

## Global Constraints

- Everything in B1's Global Constraints still holds: composite tenant foreign keys, RLS (now applied automatically to every `tenant_id` table), UUIDv7, time from the `Clock`, 404 rather than 403 for anything out of scope, strict response schemas.
- From B1's "Carried forward", now binding:
  - Handlers throw or return 2xx. The API rolls back a returned non-2xx, unlike the mock.
  - Quantity and money columns are `bigint(…, { mode: 'number' })`.
  - CI runs `drizzle-kit check` and fails when `generate` produces a diff.
- Quantities are integer kg. Money is integer rupees. Rates are whole ₹ per MT. No floats anywhere in arithmetic: use `packages/shared/src/rules/*` and never re-derive a formula.
- Status is derived, never stored (§5.3).
- Numbers:
  - Order numbers are `SO-YYMM-NNNN`, one running series per tenant per IST financial year (1 April reset).
  - Sub-order numbers append `-A`, `-B`, … in the order companies were added. A suffix is never reused (`orders.suffixes_used`).
  - Numbers come only from `number_series`, under row lock. A number is never duplicated; gaps are tolerated.
- Drafts have no number. They are autosaved with a version and purged after 7 days (§5.3).
- Plant heads and supervisors never receive a money key (`MONEY_KEYS`). The pipeline redacts, and Task 7's leak test proves it on every new route.
- All new tables carry `created_at` and `updated_at`. Orders, sub-orders, lines and trucks carry `version`. `created_by` is a column on parties, products, orders and drafts (Ruling 6).

## Rulings (decided while planning)

1. **Scope is 26 routes:**
   - parties: `GET|POST /v1/parties`, `GET|PATCH /v1/parties/:id`;
   - products: `GET|POST /v1/products`, `GET|PATCH|DELETE /v1/products/:id`;
   - orders: `POST|GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/duplicate`;
   - drafts: `GET|POST /v1/orders/drafts`, `GET|PUT|DELETE /v1/orders/drafts/:id`;
   - Home: `GET /v1/home`;
   - lifecycle: `PATCH /v1/orders/:id`, `POST /v1/sub-orders/:id/short-close`, `POST /v1/sub-orders/:id/reopen`, `POST /v1/orders/:id/move-quantity`, `GET /v1/orders/:id/delete-preview`, `DELETE /v1/orders/:id`, `GET /v1/orders/:id/activity`.

   `POST /v1/orders/:id/vehicle-requests` moves to B3, since its open/closed rule needs truck assignment. Until then `Order.vehicleRequests` is always `[]`.
2. **Trucks in B2.** Three tables are created in their final shape:
   - `trucks`, with every `TruckRec` field except `plan` and `allocations`;
   - `truck_plan_lines(tenant_id, truck_id, order_line_id, planned_kg)`;
   - `truck_allocations(tenant_id, truck_id, order_line_id, net_kg)`.

   B2 reads them for order views, Home and delete-preview. Short close cancels open trucks, and hard delete removes them. B3 adds weighments, rejections, tombstones, the truck routes and sync, all as additive migrations.
3. **Side effects that land later.** Short close and delete normally also write notifications and sync pushes, which arrive in B4. Hard delete normally also removes ledger rows and truck tombstones, which arrive in B4 and B3. B2 leaves each of these as a call into a named no-op hook (`afterShortClose`, `afterOrderDeleted` in `src/services/orderEffects.ts`) that the owning milestone fills in. The M2 contract suites do not assert them.
4. **Derived maths in TypeScript, not SQL.**
   - `loadOrderGraph(tx, orderIds)` fetches orders, sub-orders, lines, trucks, plan lines and allocations in at most 6 queries.
   - `toOrder` and `toOrderSummary` (ported from `mock-api/src/order-views.ts`, calling the same shared rules) build the responses.
   - The orders list filters by derived status in TypeScript after loading the candidate orders. The candidates are narrowed in SQL by company and plant scope, the unit filter, search text and date.

   This holds at the spec's free-tier volumes (§13 #14). B4's reports are where SQL aggregation is needed.
5. **Numbering** is done by `nextNumber(tx, key: string, fy: string): Promise<number>`, a single statement: `insert into number_series (tenant_id, series_key, fy, next_value) values ($t, $k, $fy, 2) on conflict (tenant_id, series_key, fy) do update set next_value = number_series.next_value + 1 returning next_value - 1`. That is atomic and row-locked. The FY label and the formatting come from the shared numbering rule. A failed transaction leaves a gap, which the spec tolerates.
6. **`created_by`** is a uuid column, with a composite FK to users, on `parties`, `products`, `orders` and `drafts`. `activity_log` remains the history.
7. **Party children.**
   - Contacts, numbers and addresses live in child tables: `party_contacts`, `contact_numbers`, `party_addresses`.
   - PATCH replaces each array the body includes, exactly as the mock does: rows are deleted and reinserted inside the transaction, keeping ids the body sends back.
   - Exactly one default bill-to and a unique GSTIN per tenant are enforced by partial unique indexes, which map to the mock's 422 paths.
8. **Products.**
   - `standard_lengths` is jsonb holding the shared `Length[]`.
   - `product_companies(tenant_id, product_id, company_id)` is a composite-FK join table.
   - `DELETE /v1/products/:id` behaves as in the mock: a hard delete when no order line uses the product, otherwise the mock's refusal.
9. **The contract target registers `M2_SUITES = [masters, orders, lifecycle]`** in addition to `M1_SUITES`. The `addTruck` fixture inserts trucks with plain SQL through the owner connection, as `ContractFixtures` documents ("B2 inserts it with SQL"). The fixture does not write weighment rows; delete-preview derives its weighment count from the truck itself, as in the mock.
10. **Seed.** `seed()` also inserts `SAMPLE_MASTERS` (parties with their contacts and addresses, products with their companies) with the same ids as the mock. Demo orders are not seeded, because they come from the mock's own builder. The app smoke test creates an order through the wizard instead.
11. **The delivery lifecycle is part of done (Task 8).**
   - The work lands through a pull request, not a local merge. The PR has a template, and CI must pass with the Postgres service and the drift check.
   - `CHANGELOG.md` follows Keep a Changelog, and the API exposes its version in `/v1/meta` (`apiVersion`, from package.json).
   - Each milestone ends with an annotated tag (`b2`).
   - Dependabot keeps npm and Actions updated weekly; Expo SDK packages are ignored and move only with a planned SDK upgrade.
   - Migrations are forward-only and are reviewed in the PR diff.

## Review Focus

1. **Fifty orders created at once:** fifty distinct consecutive numbers with no duplicate, including across the IST financial-year boundary at 31 March 18:30 UTC. → Task 4 concurrency test.
2. **An order edit racing a short close of the same sub-order:** exactly one wins. The other gets `409 STALE` (version), and pending is never negative. → Task 6 concurrency test.
3. **A plant head listing orders with unit and status filters:** they see only sub-orders of their plants' companies, no money keys, and the same totals as the mock for the same data. → Task 7 leak and parity tests.
4. **A move-quantity or edit that would take a line below what is already dispatched or on trucks:** `422 BELOW_DISPATCHED` (or the mock's code), with nothing written. → Task 6.
5. **Two parties saved concurrently with the same GSTIN, or two default bill-to addresses:** one succeeds and the other gets the mock's 422, never a 500. → Task 2.

---

### Task 1: B1 carry-forwards that B2 builds on

**Files:**
- Modify: `apps/api/src/db/rls.sql` (grants on `tenants`), `apps/api/src/db/client.ts` (`withTenant(tx)` restores the previous `app.tenant_id` in a `finally`), `apps/api/src/http/idempotency.ts` (check the key), `apps/api/src/services/org.ts` (`findCompany` by id)
- Modify: `packages/mock-api/src/pipeline.ts` (same key check), `packages/contract-tests/src/suites/pipeline.contract.ts` (new case)
- Create: `apps/api/test/support/lockWait.ts`, used by every concurrency test file in place of their local pollers
- Modify: `.github/workflows/ci.yml` (`pnpm --filter @tonnage/api exec drizzle-kit check` plus a "generate makes no changes" step), `docs/superpowers/plans/2026-11-04-b1-api-foundation.md` (Ruling 10: note that 413 comes before auth)
- Test: `apps/api/test/migrate.test.ts`, `apps/api/test/pipeline.test.ts`, the contract case

**Interfaces:**
- Produces:
  - `waitForLockWaiters(adminDb, n: number, opts?: { timeoutMs?: number }): Promise<void>`. It filters on `datname = current_database()` and `wait_event_type = 'Lock'`, and gives up with an error after `timeoutMs` (default 10 000).
  - The Idempotency-Key rule `^[A-Za-z0-9_-]{8,128}$`. Anything else is `422 VALIDATION` at `['idempotency-key']`, from both the mock and the API.

- [ ] **Step 1: Write the failing tests.**

```ts
// contract (pipeline): a 200-character key and a key with spaces → 422 at ['idempotency-key']
// migrate.test: tonnage_app cannot insert or delete on tenants and can update only settings, updated_at
// pipeline.test: after withTenant(tx, A) the outer tx's current_setting('app.tenant_id') is back to its previous value
// pipeline.test: a stale key purged and re-claimed in a rolled-back tx never replays a > 24 h result
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** For the stale replay, add `created_at > cutoff` to the conflict select, and re-claim an expired row inside the same statement.
- [ ] **Step 4: Run them and confirm they pass.** Then run `pnpm --filter @tonnage/contract-tests test` (the mock must stay green) and the API suite.
- [ ] **Step 5: Commit.** `fix(api,mock-api): idempotency key rule, tenants grants, withTenant restore, lock-wait helper, drift check`

---

### Task 2: Masters schema and parties

**Files:**
- Create: `apps/api/src/db/schema/masters.ts` (`parties`, `party_contacts`, `contact_numbers`, `party_addresses`, `products`, `product_companies`); generate migration `0001_masters`
- Create: `apps/api/src/routes/parties.ts`, `src/services/parties.ts` (load, validate, save children), `src/views/parties.ts` (row graph → shared `Party` / list item)
- Test: `apps/api/test/parties.test.ts`

**Interfaces:**
- Consumes: B1 `defineRoute`, `logActivity`, `pgError`.
- Produces: `loadParty(tx, id): Promise<PartyGraph | null>`, `toParty(graph)`, and `assertPartyRefs(tx, ids)` (used by orders).

The behaviour matches `mock-api/src/handlers/parties.ts` line for line:
- list query params (type, search, active);
- the 422 paths and messages;
- the activity actions;
- the transporter fields (`isSelfTransporter`);
- `masters.manage` for writes and `self.view` / masters-read for reads, exactly as the mock declares them.

- [ ] **Step 1: Write the failing tests:**
  - create with two contacts, three numbers and bill-to plus ship-to → `GET` returns the same graph;
  - PATCH replacing contacts keeps the ids it was sent and drops the others;
  - a duplicate GSTIN in the tenant → 422 at `['gstin']`, the same text as the mock;
  - a second default bill-to → 422 at `['addresses', i, 'isDefault']`;
  - another tenant's party → 404;
  - Review Focus 5: two concurrent creates with the same GSTIN → one 201 and one 422, using `waitForLockWaiters`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Map each 23505 to its 422 by constraint name.
- [ ] **Step 4: Run them and confirm they pass.** Also run `drizzle-kit check`.
- [ ] **Step 5: Commit.** `feat(api): parties with contacts and addresses`

---

### Task 3: Products

**Files:** `apps/api/src/routes/products.ts`, `src/views/products.ts`; Test: `apps/api/test/products.test.ts`

**Interfaces:** Produces `loadProducts(tx, ids)`, used by orders for the conversion and display name (the shared `productDisplayName`).

Behaviour as in `mock-api/src/handlers/products.ts`:
- the company links;
- `standardLengths`;
- the DELETE rule (Ruling 8);
- `version`, with 409 STALE on a stale version;
- the 422 paths.

- [ ] **Step 1: Write the failing tests:**
  - create a product linked to AIP and KRM → GET shows both companies;
  - PATCH with a stale version → 409 STALE;
  - DELETE an unused product → 204, then GET → 404;
  - DELETE a product an order line uses → the mock's refusal code and body (seed an order line through the owner connection).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.** `feat(api): products`

---

### Task 4: Orders schema, numbering, the order graph, and create/list/detail/duplicate

**Files:**
- Create: `apps/api/src/db/schema/orders.ts` (`orders`, `sub_orders`, `order_lines`, `drafts`, `number_series`, `trucks`, `truck_plan_lines`, `truck_allocations`); generate migration `0002_orders`
- Create: `apps/api/src/services/numbering.ts`, `src/services/orderGraph.ts`, `src/views/orders.ts` (ported from `mock-api/src/order-views.ts` and `orders-math.ts`), `src/routes/orders.ts`, `src/services/orderEffects.ts` (the Ruling 3 hooks, which do nothing yet)
- Test: `apps/api/test/orders.test.ts`, `apps/api/test/numbering.test.ts`

**Interfaces:**
- Produces:
  - `nextNumber(tx, key, fy): Promise<number>` (Ruling 5);
  - `loadOrderGraph(tx, orderIds: string[]): Promise<Map<string, OrderGraph>>`;
  - `toOrder(graph, ctx: { user; scope; now }): Order` and `toOrderSummary(graph, ctx): OrderSummary`, which must equal the mock's output for the same data;
  - `createOrder(tx, ctx, body)` (shared with duplicate and with drafts' submit, if the mock has it).

**Rules:** money and quantities go through the shared rules only:
- pricing and rounding;
- pending and dispatched;
- derived status;
- the order number format;
- the commission snapshot.

- [ ] **Step 1: Write the failing tests.**
  - `numbering.test`: Review Focus 1, fifty parallel `POST /v1/orders` (a real pool of ≥ 10) → fifty distinct consecutive numbers.
  - `numbering.test`: the FY boundary, with the clock at 2027-03-31T18:29:59Z and then 18:30:00Z → the series resets to 0001 and the YYMM changes.
  - `orders.test`: the same create body as the contract's canonical case → the response deep-equals what the mock returns for that body. Build both from one fixture: start `createMockApi()`, then post to both.
  - `orders.test`: the list with status/unit/search filters and sort equals the mock's list for the same three orders.
  - `orders.test`: duplicate → a new order with the same lines and a new number.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Use the Ruling 4 structure and indexes on `orders(tenant_id, created_at desc)`, `sub_orders(tenant_id, order_id)`, `order_lines(tenant_id, sub_order_id)`, `trucks(tenant_id, sub_order_id, state)`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.** `feat(api): orders: numbering under row lock, create, list, detail, duplicate`

---

### Task 5: Drafts and Home

**Files:** `apps/api/src/routes/drafts.ts`, `src/routes/home.ts`, `src/views/home.ts`; Test: `apps/api/test/drafts.test.ts`, `apps/api/test/home.test.ts`

Behaviour as in `mock-api/src/handlers/drafts.ts` and `home.ts`:
- a draft belongs to its creator, and another person's draft is 404;
- PUT carries a version, with 409 STALE on a stale one;
- drafts are purged after 7 days. Purging happens on each list read by the clock; there is no job yet.
- Home's figures (pending by company, booked today, dispatched today, In plant now) use IST day boundaries from the shared helpers.

- [ ] **Step 1: Write the failing tests:**
  - an 8-day-old draft is gone from the list;
  - Priya cannot read Rajesh's draft (404);
  - Home equals the mock's Home for the same data, including one dispatched truck inserted today through the owner connection, with "dispatched today" counted by IST date;
  - a plant head's Home shows no money keys.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.** `feat(api): drafts and Home`

---

### Task 6: Order lifecycle

**Files:** `apps/api/src/routes/orderLifecycle.ts`, `src/services/orderLifecycle.ts` (edit, short close, reopen, move, delete, preview, activity); Test: `apps/api/test/order-lifecycle.test.ts`

Behaviour as in `mock-api/src/handlers/order-lifecycle.ts`:
- the edit limits (shared rules);
- `OPEN_TRUCKS` without `cancelOpenTrucks`, and cancelling them;
- reopen;
- move quantity between companies with a new suffix;
- delete-preview counts;
- hard delete removes every order row, including trucks and their plan and allocation rows, and calls `afterOrderDeleted`;
- activity in newest-first order;
- every write is idempotent (it refuses without a key, which the pipeline already does when `idempotent: true`) and versioned;
- the lock order is the order row first (`for no key update`), then its sub-orders by id, then its lines.

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 2: an edit and a short close of the same sub-order at once, staged with `waitForLockWaiters` → one succeeds and the other gets 409 STALE; pending ≥ 0 afterwards.
  - Review Focus 4: moving more than is undispatched → the mock's 422 with nothing written. Assert row counts and versions are unchanged.
  - Short close with two open trucks and `cancelOpenTrucks` → both trucks cancelled with the reason, and activity `meta.trucksCancelled = 2`.
  - Hard delete → zero rows for that order in `orders`, `sub_orders`, `order_lines`, `trucks`, `truck_plan_lines`, `truck_allocations` and `activity_log` (spec §10.1).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.** `feat(api): order lifecycle: edit, short close, reopen, move quantity, delete, activity`

---

### Task 7: The M2 contract green, permission matrix, serializer leak, seed and app smoke test

**Files:**
- Modify: `packages/contract-tests/src/index.ts` (export `M2_SUITES`), `apps/api/test/contract.test.ts` (register `M1_SUITES` and `M2_SUITES`), `apps/api/test/api-fixtures.ts` (`addTruck` with SQL, Ruling 9), `apps/api/test/route-parity.test.ts` (48 routes)
- Create: `apps/api/test/policy-matrix.test.ts`, `apps/api/test/money-leak.test.ts`
- Modify: `apps/api/src/db/seed.ts` (adds `SAMPLE_MASTERS`, Ruling 10), `CLAUDE.md` (the `apps/api` bullet: M2 routes and suites), `README.md` (nothing changes unless a command does)

**Interfaces:**
- `policy-matrix.test`: for every role × every M1+M2 route, the status (2xx, 403 or 404) matches `can(role, action)` and the plant scope. The cases are generated from `routeTable(app)` plus `policy.ts`, not written by hand.
- `money-leak.test`: signs in as Kiran (plant head) and Ravi (supervisor), calls every GET route in `routeTable` with real ids, walks each JSON body, and fails on any key in `MONEY_KEYS`.

- [ ] **Step 1: Write the tests and run them.** `pnpm --filter @tonnage/api exec vitest run test/contract.test.ts test/route-parity.test.ts test/policy-matrix.test.ts test/money-leak.test.ts`. Every M1 and M2 contract case must pass. A failure means fix the API; change a suite only if it contradicts the spec, and then re-run the mock as well.
- [ ] **Step 2: Run everything.** `pnpm lint && pnpm typecheck && pnpm test`, all green. Push the branch and confirm CI is green, including the drift check.
- [ ] **Step 3: App smoke test against the local API** (`pnpm dev:db`, `db:migrate`, `db:seed`, `dev:api`, then Metro with `EXPO_PUBLIC_API_MODE=http EXPO_PUBLIC_API_URL=http://127.0.0.1:3000` and `adb reverse tcp:3000 tcp:3000`). As Rajesh:
  - open Customers & brokers and a party;
  - create an order with the wizard;
  - open it, edit a rate, short close a line;
  - check Home's figures move.

  Then sign in as Kiran and confirm no ₹ appears. Record what you saw in the PR description.
- [ ] **Step 4: Commit.** `test(api): M2 contract, permission matrix and money leak green against the real API`

---

### Task 8: Delivery lifecycle (Ruling 11)

**Files:**
- Create: `CHANGELOG.md` (Keep a Changelog; an `[Unreleased]` section listing B2, and back-filled one-line entries for F1–F5, B1 and Request vehicle from `git log` merge commits)
- Create: `.github/pull_request_template.md`. Sections: Summary; Why; How tested (commands and counts); Screens (light/dark when UI changed); Migrations (forward-only? data impact?); Rollback; Checklist covering contract test first, CLAUDE.md updated and CHANGELOG updated.
- Create: `.github/dependabot.yml` (weekly npm for the workspace root and weekly github-actions; ignore `expo`, `expo-*`, `react-native` and `@expo/*`, which move only with an Expo SDK upgrade; group dev dependencies)
- Modify: `.github/workflows/ci.yml`:
  - `concurrency` cancels superseded runs on the same ref;
  - the pnpm store is cached through `actions/setup-node` `cache: pnpm`;
  - the job is named `verify`, so it can be made a required check;
  - triggers are `pull_request` and `push` to `main`.
- Modify: `apps/api/src/routes/meta.ts` and `packages/shared` `metaSchema`: add `apiVersion: string` from `apps/api/package.json`, which becomes `0.2.0` for B2. The mock returns its own version, so the contract only checks that it is a string. Update the contract case.
- Modify: `CLAUDE.md` Conventions: work on a branch, merge through a PR with green CI, update CHANGELOG, tag each milestone.

- [ ] **Step 1: Write the failing test.** The contract meta case expects `apiVersion` to be a non-empty string.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement the files above.** Check the YAML parses (`node -e` with the `yaml` package if it is in the tree, otherwise `npx --yes yaml-lint`), and that `actionlint` passes if available.
- [ ] **Step 4: Run it and confirm it passes**, then run `pnpm lint && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit.** `chore: delivery lifecycle: changelog, PR template, dependabot, CI concurrency and cache, apiVersion`

The finish (done by the controller, not a task): push the branch, open the PR with the template filled in, wait for CI to pass, merge it, tag `b2` on the merge commit, and move the Notion B2 card to Completed.
