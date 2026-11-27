# B3 Dispatch & Sync on Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real API serves dispatch end to end on Postgres:
- trucks: assign, edit, cancel, the dispatch board, truck detail with the plant's supervisors, recent vehicles;
- the supervisor's phone: tasks pull, done today, and weighment sync (AT_GATE, TARE, GROSS);
- the office: approval (the dispatch), weight correction, and Needs attention (restore, dismiss);
- vehicle requests.

It passes the contract suites `trucks`, `sync`, `approval`, `supervisors`, `rejections` and `vehicle-requests` that the mock passes. It also adds the guarantees only a database can prove: one winner when two people dispatch the same truck, no lost task change on the phone however transactions interleave, and no event applied twice.

**Architecture:**
- The B1/B2 foundation stays: `defineRoute`, RLS on every `tenant_id` table, composite tenant FKs, the `Clock`, redaction, idempotency, forward-only migrations.
- One additive migration (`0004_dispatch`) adds the dispatch tables.
- The mock's dispatch core (`packages/mock-api/src/dispatch.ts`, `truck-views.ts`, and the handlers `trucks`, `supervisor`, `rejections`, `vehicle-requests`) is ported to `apps/api/src/services/dispatch/*`. It calls the same pure rules in `packages/shared/src/rules/{trucks,numbering,ledger,vehicleRequest}.ts`, so the business maths has one implementation.
- Two new pipeline capabilities:
  - **per-event transactions**, for sync;
  - **a per-tenant change clock** that makes the phone's pull cursor safe under concurrency (Ruling 3).

**Tech Stack:** as in B1/B2: Fastify 5, Drizzle + drizzle-kit, `pg`, zod, Vitest, embedded Postgres 16 locally and `postgres:16` in CI.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md`:
- §4: the Dispatch and Money tables;
- §5.2: the truck state machine;
- §5.4: money and the broker earning;
- §5.7: the dispatch transaction;
- §6: offline weighment and sync, especially §6.3–6.6;
- §10.1: concurrency and sync tests.

The binding addenda are TON-57 rulings 9–20 (arrival before tare, weighed then approval, correction). Behaviour is defined by the reference mock and the contract suites. Where they disagree with this plan, the contract decides.

## Global Constraints

- Everything in B1's and B2's Global Constraints still holds:
  - composite tenant FKs, RLS, UUIDv7;
  - time from the `Clock`;
  - 404 rather than 403 for anything out of scope;
  - strict response schemas;
  - a returned non-2xx rolls back;
  - `bigint(…, { mode: 'number' })` for kg and ₹;
  - CI's `drizzle-kit check` and its generate-makes-no-diff step.
- Quantities are integer kg and money is integer rupees. All maths goes through `packages/shared/src/rules/*`, never a re-derived formula.
- Status is derived, never stored.
- Loading slips come only from `number_series` (B2's `nextNumber`). The key is `ls:<companyId>` and the period is the IST financial year, exactly as the mock's `nextNumber(state, tenant, 'ls:'+companyId, at)`. They are formatted with `formatLoadingSlip`.
- Business time for a weighment is `captured_at = device time + offset` (§6.6). `received_at` is the server's `now`. An offset beyond `CLOCK_SKEW_FLAG_MS` is flagged in the activity meta.
- Plant heads and supervisors never receive a money key. The approval response, truck detail and board for those roles are redacted by the pipeline, and Task 9 proves it.
- New tables carry `created_at` and `updated_at`. `trucks.version` bumps on every truck write.
- **Lock order** for every write that touches a truck, extending B2's order → sub-orders → lines:
  1. the tenant change-clock row (Ruling 3);
  2. the order (`for no key update`);
  3. its sub-orders by id;
  4. their lines;
  5. the trucks by id;
  6. rejections.

  Deadlocks still map to 503 `BUSY` (B2).

## Rulings (decided while planning)

1. **Scope is 16 routes; the route table goes from 48 to 64.**
   - trucks:
     - `POST /v1/sub-orders/:id/trucks`;
     - `PATCH /v1/trucks/:id`;
     - `POST /v1/trucks/:id/cancel`;
     - `POST /v1/trucks/:id/approve`;
     - `POST /v1/trucks/:id/correct-weight`;
     - `GET /v1/trucks/recent-vehicles`;
     - `GET /v1/trucks/:id`;
     - `GET /v1/dispatch`.
   - phone: `GET /v1/supervisor/tasks`, `GET /v1/supervisor/done-today`, `POST /v1/weighments/sync`.
   - needs attention:
     - `GET /v1/weighment-rejections`;
     - `GET /v1/weighment-rejections/count`;
     - `POST /v1/weighment-rejections/:id/restore`;
     - `POST /v1/weighment-rejections/:id/dismiss`.
   - vehicle requests: `POST /v1/orders/:id/vehicle-requests`.

   The actions, `idempotent` flags and 422 paths are copied from the mock's route declarations.

2. **Migration `0004_dispatch`** (additive; the B2 truck tables are untouched apart from new indexes):
   - `weighments(id, tenant_id, truck_id, kind tare|gross, kg, entered_by, device_id, client_event_id, captured_at_device, captured_at, received_at, clock_skew_flag, superseded_by null)`, with unique `(tenant_id, client_event_id)` where `client_event_id` is not null. A correction's rows have a null event id.
   - `sync_events(tenant_id, client_event_id, user_id, truck_id, result jsonb, created_at)`, PK `(tenant_id, client_event_id)`. This is the replay store for `replayed` and `remember`.
   - `weighment_rejections(id, tenant_id, client_event_id, truck_id, user_id, device_id, offset_ms, event jsonb, code, server_state, status open|restored|dismissed, created_at, resolved_by, resolved_at, resolution_note)`, indexed on `(tenant_id, status)` and `(tenant_id, user_id, resolved_at)`.
   - `truck_tombstones(tenant_id, truck_id, plant_id, reason cancelled|weighed|dispatched|deleted|moved, removed_at)`, indexed on `(tenant_id, plant_id, removed_at)`.
   - `broker_ledger`, in its final shape as in spec §4 (Ruling 5). B3 writes earnings and reversals only.
   - `vehicle_requests(id, tenant_id, order_id, party_id, phone, channel, message, total_kg, requested_by, requested_at)` and `vehicle_request_lines(tenant_id, request_id, order_line_id, kg)`.
   - `tenant_sync_clock(tenant_id pk, last_change_at timestamptz)` (Ruling 3).
   - A **deferred constraint trigger** on `trucks` and `truck_allocations` (spec §4): for a truck in `weighed` or `dispatched`, Σ `net_kg` = `gross_kg − tare_kg`. It is checked at commit, as defence in depth behind the shared `checkAllocations`.
   - Indexes:
     - `trucks(tenant_id, plant_id, updated_at)`;
     - `trucks(tenant_id, state)`;
     - `trucks(tenant_id, vehicle_key, assigned_at desc)`;
     - `weighments(tenant_id, truck_id)`;
     - `broker_ledger(tenant_id, broker_id, created_at)`, `broker_ledger(tenant_id, truck_id)`.

3. **The pull cursor is a per-tenant change clock** (the safety rule of §6.3).
   - **The problem:** the contract fixes the cursor as an ISO date-time. A plain `max(updated_at)` cursor loses changes when an older transaction commits after a newer one has been pulled, the classic out-of-order-commit problem of `updated_at` polling.
   - **The fix:** every write that changes what a phone sees calls `bumpChangeClock(tx, tenantId, now): Promise<string>`. That is one statement, `insert … on conflict (tenant_id) do update set last_change_at = greatest(tenant_sync_clock.last_change_at + interval '1 millisecond', $now) returning last_change_at`. Its value becomes the `updated_at` of the trucks it writes, and the `removed_at` / `resolved_at` of the tombstones and rejections it writes.
   - **Why it works:**
     - The row lock it takes is held until commit, so truck writes within one tenant run one after another. Each is a few milliseconds; Replicache cites about 50 pushes a second per space, far beyond this tenant's volume. That is Replicache's "per-space version" strategy. To keep the hold short, writers bump first (lock order 1) and do no slow work after it.
     - Change times are strictly increasing.
     - `GET /v1/supervisor/tasks` first reads `last_change_at … for share`. That waits until in-flight writers commit, and then everything up to that time is visible.
     - The returned cursor is `max(since, last_change_at)`. With at-least-once (`>= cursor`) delivery, no change can fall behind a cursor already handed out.
   - **Rejected alternatives:**
     - the `xid8` / `pg_snapshot_xmin` snapshot cursor, which needs an opaque, non-time cursor and so breaks the contract;
     - a lag window, which is fragile and still loses changes under a long transaction.

4. **Sync is idempotent at two levels, with one transaction per event** (§6.4).
   - `defineRoute` gains `eventTransactions: true`. The request transaction still runs auth, policy and the Idempotency-Key claim, and it stores the final answer.
   - The handler's new `ctx.inOwnTransaction(fn)` runs each event on another pool connection, in its own `withTenant` transaction.
   - A concurrent request with the same key waits on the claim row, then replays the whole answer.
   - Inside an event:
     1. `insert into sync_events … on conflict do nothing returning`.
     2. If no row came back, the event was seen before: return the stored result. A replayed rejection still blocks that truck's later events in this request.
     3. Otherwise apply the event, store its result, and commit.
   - A crash between events is safe: the phone retries with the same key, every applied event replays, and the rest apply. The pool needs at least 2 connections per concurrent sync request; the default of 10 is kept.

5. **The broker ledger arrives in B3, not B4**, because the spec's dispatch transaction (§5.7, §6.8) writes the earning atomically.
   - B3 writes:
     - `earning` at approval (`truckEarning` from the order's commission snapshot and the line overprices);
     - `reversal` plus a replacement `earning` on a weight correction after dispatch (the mock's `rewriteEarning`);
     - removal of a truck's earning and reversal rows on an order's hard delete. Payments stay, as in the mock.
   - B4 adds payments, payment reversal, the read routes and reports.
   - No M3 suite reads the ledger, so an API test (Task 6) compares the ledger rows to what the mock writes for the same steps.

6. **Notifications stay in B4.**
   - Every place the mock calls `notify*` (assigned, changed, arrived, weighed, dispatched, over tolerance, rejection) calls a named no-op in `services/dispatchEffects.ts`. B4 fills them in, as B2's `orderEffects` did.
   - The one M3 case that reads `/v1/notifications` (approval: "who is told") is gated by a new target capability, `capabilities.notifications: boolean`. The mock declares `true`; the API declares `false` until B4. The case becomes `it.skipIf(!caps.notifications)`, and the mock still runs it.
   - That is the only change to a contract suite.

7. **B2's effect hooks are filled where B3 owns them:**
   - `afterShortClose` writes `cancelled` tombstones for the trucks it cancelled.
   - `afterOrderDeleted` writes `deleted` tombstones for the order's trucks and removes their ledger earning and reversal rows, before the trucks go.
   - Both bump the change clock.
   - `Order.vehicleRequests` stops being `[]`: `toOrder` lists open requests through the shared `vehicleRequest` rules, trimmed for plant heads as the mock does.

8. **Reads build views in TypeScript, as in B2** (B2 Ruling 4).
   - `loadDispatchGraph(tx, { truckIds? , plantIds?, states? })` loads trucks, plan, allocations, weighments, sub-orders, lines, orders, parties, products and companies in a bounded number of queries.
   - `toTruck`, `toTask`, `boardOrder` and `plantSupervisors` are ported from `truck-views.ts` and must equal the mock's output.
   - The board filters (state, plant, search) narrow candidates in SQL by plant scope and state, then match exactly as the mock does.

9. **The contract target registers `M3_SUITES = [vehicleRequests, trucks, sync, approval, supervisors, rejections]`** as well as M1 and M2.
   - The `addTruck` fixture stays SQL (B2 Ruling 9). For `weighed` and `dispatched` trucks it now also writes the matching weighment rows and bumps the change clock, so detail views and pulls see them.

10. **Seed.** Demo trucks are not seeded: like demo orders, they come from the mock's builder. The smoke test (Task 9) creates them through the app.

11. **Delivery** as in B2 Ruling 11:
    - a PR with the template and green `verify`;
    - CHANGELOG `[Unreleased]`;
    - `apiVersion` `0.3.0`;
    - an annotated tag `b3` on the merge commit;
    - the Notion B3 milestone card moved to Completed.

## Review Focus

1. **Two people approve the same weighed truck at the same moment:** exactly one 200 with one loading-slip number and one earning row. The other gets the mock's `NOT_AWAITING_APPROVAL` (409), and the series has no duplicate. → Task 6 concurrency test.
2. **A phone pulls while a slow approval or cancel is mid-transaction:** the next pull with the returned cursor still contains that truck's change. Nothing is lost whatever the commit order. → Task 7 fence test (Ruling 3), staged with `waitForLockWaiters`.
3. **The same sync request sent twice at once with the same Idempotency-Key, and the same events in a new request with a new key:** each event is applied once. The second request replays the first answer, or returns each event's stored result. No weighment is duplicated. → Task 7.
4. **A short close or hard delete racing an assignment or a GROSS sync on the same sub-order:** no truck is left assigned to a closed line, and pending is never negative. The loser gets the mock's code (`LINE_CLOSED`, `TRUCK_CANCELLED` …) and its weight lands in Needs attention, never lost. → Task 5 and Task 7.
5. **A weight correction after dispatch that pushes pending back above the tolerance:** the tolerance close is undone, the earning is reversed and replaced at the dispatch-time rates, and the ledger sum equals the mock's. A correction that breaks Σ allocations = net is refused by the shared check and, failing that, by the deferred trigger. → Task 6.

---

### Task 1: Pipeline capabilities: per-event transactions, the change clock, the notifications capability

**Files:**
- Modify:
  - `apps/api/src/http/route.ts`: `eventTransactions?: true` on the authed config, and `inOwnTransaction` on `RouteCtx`;
  - `apps/api/src/db/client.ts`: export `runTenantTx(db, tenantId, fn)` for a fresh pool transaction.
- Create:
  - `apps/api/src/services/changeClock.ts`: `bumpChangeClock`, `readChangeClockForShare`;
  - the `tenant_sync_clock` table, in `src/db/schema/dispatch.ts`. Its migration is generated in Task 2, which owns `0004`; until then Task 1 uses a test-only DDL in `test/support/world.ts`.
- Modify:
  - `packages/contract-tests/src/harness.ts`: `capabilities.notifications`;
  - `packages/contract-tests/src/suites/approval.contract.ts`: `skipIf` on "who is told";
  - `packages/contract-tests/src/mock.test.ts`: the mock declares `notifications: true`;
  - `apps/api/test/contract.test.ts`: the API declares `false`.
- Test: `apps/api/test/pipeline.test.ts`, `apps/api/test/change-clock.test.ts`.

**Interfaces:**
- Produces:
  - `RouteCtx.inOwnTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>`. It exists only when `eventTransactions: true`; otherwise the property is absent and the type forbids its use.
  - `bumpChangeClock(tx: Tx, tenantId: string, now: number): Promise<string>`, which returns the ISO change time.
  - `readChangeClockForShare(tx: Tx, tenantId: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests:**
  - `inOwnTransaction`: work committed in an event transaction survives an error thrown later in the request transaction, and a throw inside one event does not roll back an earlier event;
  - a second request with the same Idempotency-Key waits for the first and replays its body with `idempotent-replay: true`;
  - `bumpChangeClock` called twice in one millisecond returns strictly increasing times;
  - `readChangeClockForShare` blocks while another transaction holds a bump. Stage it with `waitForLockWaiters(adminDb, 1)`, then commit the writer: the reader sees the writer's time;
  - the contract mock run is still all green, with "who is told" still executed.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, along with `pnpm --filter @tonnage/contract-tests test`.
- [ ] **Step 5: Commit.** `feat(api,contract-tests): per-event transactions, tenant change clock, notifications capability`

---

### Task 2: Dispatch schema (`0004_dispatch`)

**Files:**
- Create: `apps/api/src/db/schema/dispatch.ts`, with the tables of Ruling 2 and their relations, exported from `schema/index.ts`.
- Generate: `drizzle/0004_dispatch.sql`. Append the deferred constraint trigger by hand in a following statement block, so it survives `generate`.
- Modify: `apps/api/src/db/rls.sql`. Nothing should be needed, because RLS is applied to every `tenant_id` table automatically. Assert that in the test.
- Test: `apps/api/test/migrate.test.ts`, `apps/api/test/dispatch-schema.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - every new table has RLS enabled, and `tonnage_app` cannot read another tenant's rows;
  - a cross-tenant `truck_id` in `weighments`, `truck_tombstones` or `broker_ledger` fails its composite FK;
  - a second `weighments` row with the same `(tenant_id, client_event_id)` fails;
  - the deferred trigger: committing a `weighed` truck whose allocations sum to net − 1 kg fails with its named constraint, and the same rows with the right sum commit;
  - `drizzle-kit check` passes, and `generate` produces no diff.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Map the trigger's SQLSTATE `23514`, and each new unique constraint, to the mock's codes in `pg-error.ts` (`ALLOC_MISMATCH` for the trigger).
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.** `feat(api): dispatch schema: weighments, sync events, rejections, tombstones, broker ledger, vehicle requests`

---

### Task 3: Truck views and reads: detail, board, supervisors, recent vehicles

**Files:**
- Create:
  - `apps/api/src/services/dispatch/graph.ts`: `loadDispatchGraph`;
  - `src/views/trucks.ts`: `toTruck`, `toTask`, `boardOrder`, `plantSupervisors`, `vehicleKey` and `sameIstDay`, ported from `truck-views.ts`;
  - `src/routes/trucks.ts`, with the read routes only: `GET /v1/trucks/:id`, `GET /v1/dispatch`, `GET /v1/trucks/recent-vehicles`.
- Test: `apps/api/test/trucks-read.test.ts`.

**Interfaces:**
- Produces:
  - `loadDispatchGraph(tx, q: { truckIds?: string[]; plantIds?: string[] | 'all'; states?: TruckState[] }): Promise<DispatchGraph>`;
  - `toTruck(g, truckId, ctx: { user; scope; now; withWeighments: boolean }): Truck`;
  - `toTask(g, truckId): Task`.

  Every one of them must deep-equal the mock's output for the same data.

- [ ] **Step 1: Write the failing tests.** Build both sides from one fixture: start `createMockApi()`, replay the same `addTruck` calls on both, then compare.
  - Truck detail for an assigned, a weighed and a dispatched truck matches the mock, including `supervisors` (active ones of the plant only, phone and WhatsApp numbers as the mock gives them).
  - The board with each state filter, plant scope for Kiran, and search by vehicle (`vehicleKey`) matches the mock, in `boardOrder` order.
  - Recent vehicles returns newest first, unique by vehicle key, with the mock's fields and limit.
  - A truck of another tenant, or of a plant out of scope, returns 404.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run the `trucks` contract describe "dispatch board and detail" and the `supervisors` suite against the API.
- [ ] **Step 5: Commit.** `feat(api): truck detail, dispatch board, supervisors, recent vehicles`

---

### Task 4: Assign, edit, cancel

**Files:**
- Modify: `apps/api/src/routes/trucks.ts`.
- Create:
  - `src/services/dispatch/assign.ts`: assign, edit, cancel;
  - `src/services/dispatchEffects.ts`: the Ruling 6 no-ops `afterTruckAssigned`, `afterTruckChanged`, `afterTruckCancelled`, `afterArrived`, `afterWeighed`, `afterDispatched`, `afterOverTolerance` and `afterRejection`.
- Test: `apps/api/test/trucks-write.test.ts`.

Behaviour as in `mock-api/src/handlers/trucks.ts` lines 88–243:
- the plan validation against pending (shared `quantities`);
- transporter and plant checks with the 422 paths;
- `VEHICLE_BUSY`;
- edit with `version`, returning 409 `STALE`;
- cancel reasons (`TRUCK_CANCEL_REASONS`);
- the activity actions;
- every write bumps the change clock (Ruling 3);
- cancel writes a `cancelled` tombstone.

- [ ] **Step 1: Write the failing tests:**
  - assign a plan within pending → 201, with a truck whose `version` is 1, then the activity `truck.assigned`, and a pull cursor that moves;
  - assign more than pending → the mock's 422 at the mock's path;
  - edit with a stale version → 409 `STALE`;
  - cancel → state `cancelled`, a tombstone, and the truck in `removed` on the next pull;
  - Review Focus 4: an assign and a short close of the same sub-order at once (stage the short close holding the order lock with `waitForLockWaiters`) → either the truck is assigned and then cancelled by the short close, or the assign gets the mock's closed-line code. Never a truck on a closed line.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**, following the Global Constraints lock order.
- [ ] **Step 4: Run them and confirm they pass.** Run the `trucks` suite's "assign" and "edit and cancel" describes against the API.
- [ ] **Step 5: Commit.** `feat(api): assign, edit and cancel trucks`

---

### Task 5: The dispatch core: AT_GATE, TARE, GROSS, approve, tolerance close

**Files:**
- Create: `apps/api/src/services/dispatch/apply.ts`, a port of `dispatch.ts`:
  - `applyEvent`, `markArrived`, `currentWeighment`;
  - `approveDispatch`, `issueLoadingSlip`;
  - `closeWithinTolerance`, `undoToleranceClose`;
  - `writeEarning`, `reverseEarning`, `rewriteEarning`.
- Modify: `src/routes/trucks.ts`, adding `POST /v1/trucks/:id/approve`.
- Test: `apps/api/test/dispatch-core.test.ts`.

**Interfaces:**
- Produces:
  - `applyEvent(tx, ctx: DispatchCtx, event: SyncEvent): Promise<SyncResult>`, with `DispatchCtx = { user: AuthedUser; scope; deviceId: string; now: number; offsetMs: number; changeAt: string }`;
  - `approveDispatch(tx, ctx, truckId, version?): Promise<Truck>`.

  Results and codes equal the mock's for the same sequence.

Rules, as in the mock and the TON-57 rulings:
- TARE needs the truck arrived (`ARRIVAL_REQUIRED`).
- AT_GATE on a dispatched, cancelled, at-gate or loading truck is an accepted no-op.
- GROSS puts the truck in `weighed` (awaiting approval) with allocations from `checkLineWeights` / `checkAllocations`. A later TARE or GROSS is `ALREADY_WEIGHED`.
- Approve is the dispatch:
  1. set `dispatched_at = now`;
  2. issue the loading slip (`ls:<companyId>`);
  3. write the earning (Ruling 5);
  4. run the tolerance close (`toleranceCloseKg` with the tenant's `completionToleranceKg`, and no other open truck on the sub-order).
- TARE_CONFLICT: first synced wins, and the answer carries the winning value, who and when.

- [ ] **Step 1: Write the failing tests:**
  - the full TON-57 path (assign → AT_GATE → TARE → GROSS with two lines → approve) gives the mock's states, slip number `LS-<code>-YYMM-0001`, allocations, weighments and activity;
  - the ledger: one earning row equal to `truckEarning(...)` for the order's snapshot rates;
  - tolerance: the last truck within 1,000 kg closes the remaining lines as `tolerance`; with another open truck it does not;
  - Review Focus 1: two approvals at once (`capabilities.concurrency`, staged with `waitForLockWaiters`) → one 200 and one 409 `NOT_AWAITING_APPROVAL`, one slip number, one earning;
  - Review Focus 4: a GROSS applied after the sub-order was short closed → `rejected TRUCK_CANCELLED` (or the mock's code), with nothing written but the rejection.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, with the `approval` suite against the API (its "who is told" case is skipped, Ruling 6).
- [ ] **Step 5: Commit.** `feat(api): dispatch core: arrival, tare, gross, approval, tolerance close, broker earning`

---

### Task 6: Weight correction

**Files:**
- Modify: `src/routes/trucks.ts`, adding `POST /v1/trucks/:id/correct-weight`; `src/services/dispatch/apply.ts`.
- Test: `apps/api/test/weight-correction.test.ts`.

Behaviour as in the mock and the TON-57 rulings:
- `weighment.correct` (owner and city staff), with a version and a reason.
- While weighed, it only replaces the weights.
- After dispatch, it supersedes the weighments, rewrites the allocations, and calls `rewriteEarning`: a reversal plus a replacement at the earning's original per-MT rates, both dated on the correction.
- A correction that pushes pending above the tolerance undoes the tolerance close; one that pulls it back under re-closes.

- [ ] **Step 1: Write the failing tests:**
  - a correction while weighed, then approve: one earning, at the corrected net;
  - Review Focus 5: dispatch, then a correction that undoes the tolerance close → the lines reopen. The ledger is the earning, its exact negation, and the replacement, and the sum equals the mock's;
  - a correction whose allocations do not sum to the new net → the mock's 422, with nothing written;
  - a stale version → 409 `STALE`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, with the `rejections` suite's "weight correction" describe against the API.
- [ ] **Step 5: Commit.** `feat(api): weight correction with earning reversal and tolerance undo`

---

### Task 7: The phone: weighment sync, tasks pull, done today

**Files:**
- Create: `apps/api/src/routes/supervisor.ts`, `src/services/dispatch/sync.ts` (the per-event loop, blocking, rejection recording, device offset).
- Test: `apps/api/test/sync.test.ts`, `apps/api/test/sync-concurrency.test.ts`.

Behaviour as in `mock-api/src/handlers/supervisor.ts`:
- `X-Device-Time` gives the offset, or 0 without it.
- Events are processed in body order, each in `ctx.inOwnTransaction` (Ruling 4).
- A truck with a rejected event in this request gets `INVALID_STATE` "Blocked by an earlier rejected weight" for its later events, with `server.state` only when it is in scope.
- Rejections are recorded only for trucks in the tenant.
- The tasks pull, as in the mock: `items`, `removed`, `resolved` and `deleted` with the `RESOLVED_HORIZON_MS` (30 days) cursorless horizon, `serverTime`, and the cursor from Ruling 3.
- Done today goes by `weighed_at`'s IST day, newest first, with `totalNetKg`.

- [ ] **Step 1: Write the failing tests** (spec §10.1's sync list):
  - **replay:** the same request twice with one key → the second has `idempotent-replay: true` and the same body;
  - **duplicate:** the same events with a new key → each event's stored result, and one weighment row each;
  - **out-of-order:** a GROSS before its TARE in one request → the mock's code, with the TARE applied after;
  - tare conflict between two devices: first synced wins, with the winner's value, who and when;
  - a cancelled truck → `TRUCK_CANCELLED` and a rejection row;
  - a deactivated user → 401 on refresh, which is B1 behaviour; assert that the events are not applied;
  - clock skew: `X-Device-Time` 10 minutes behind → `captured_at` corrected, and the activity meta flags the skew;
  - Review Focus 2, the fence: start an approval, hold it open past its change-clock bump with a gate, pull concurrently (it waits, as `waitForLockWaiters` confirms), then commit the approval. The pull's items include the change; a second pull with the returned cursor repeats it at least once and never skips it.
  - Review Focus 3: two identical sync requests at once with the same key → one applies and one replays. With different keys → each event is applied once (`sync_events` claim).
  - The cursorless horizon: a 31-day-old dismissal is absent; a 29-day-old one is present.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, with the `sync` suite against the API.
- [ ] **Step 5: Commit.** `feat(api): weighment sync, tasks pull with a safe cursor, done today`

---

### Task 8: Needs attention, vehicle requests, B2's hooks

**Files:**
- Create:
  - `apps/api/src/routes/rejections.ts`, `src/services/dispatch/rejections.ts` (list, count, restore, dismiss);
  - `src/routes/vehicleRequests.ts`, `src/services/vehicleRequests.ts`.
- Modify:
  - `src/services/orderEffects.ts` (Ruling 7);
  - `src/views/orders.ts` (`Order.vehicleRequests` from the shared rules);
  - `src/services/orderLifecycle.ts` (the delete path removes ledger rows before the trucks).
- Test: `apps/api/test/rejections.test.ts`, `apps/api/test/vehicle-requests.test.ts`, additions to `apps/api/test/order-lifecycle.test.ts`.

Behaviour as in `mock-api/src/handlers/rejections.ts` and `vehicle-requests.ts`:
- Restore reinstates a cancelled truck where the mock does, re-applies the event in the same transaction, and may return `warnings` (`VEHICLE_BUSY`, `OVER_ASSIGNABLE`).
- Dismiss takes a 3–200 character reason.
- Both mark the rejection resolved at the change-clock time, so the owner's phone sees it in `resolved`.
- A vehicle request returns 201 `{ request }` and is idempotent.
- Its 422 paths are `lines.N.kg`, `totalKg` and `partyId`.
- It writes the activity `order.vehicle_requested`.
- It is open until a non-cancelled truck is assigned after it, or its lines close.

- [ ] **Step 1: Write the failing tests:**
  - restore of a `TRUCK_CANCELLED` rejection → the truck is reinstated and the weight applied, matching the mock, and the owner's next pull lists it in `resolved`;
  - dismiss with a 2-character reason → 422;
  - a vehicle request, then an assignment after it → `Order.vehicleRequests` is empty; a plant head sees only their sub-orders' lines;
  - hard delete of an order with a dispatched truck → `deleted` tombstones, no earning or reversal rows left for its trucks, a payment row untouched, and zero rows in every dispatch table for the order's trucks (spec §10.1 "hard delete leaves zero rows");
  - short close cancelling two open trucks → two `cancelled` tombstones in the plant's next pull.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, with the `rejections` and `vehicle-requests` suites, plus M2's `order-lifecycle` suite, which must stay green.
- [ ] **Step 5: Commit.** `feat(api): needs attention, vehicle requests, tombstones and ledger cleanup on order writes`

---

### Task 9: M3 contract green, permission matrix, money leak, app smoke on a device

**Files:**
- Modify:
  - `packages/contract-tests/src/index.ts`: export `M3_SUITES` (Ruling 9);
  - `apps/api/test/contract.test.ts`: register M1 + M2 + M3;
  - `apps/api/test/api-fixtures.ts`: `addTruck` weighments and clock bump;
  - `apps/api/test/route-parity.test.ts`: 64 routes;
  - `apps/api/test/policy-matrix.test.ts` and `money-leak.test.ts`: these walk `routeTable` and pick up the new routes; add real ids for trucks, rejections and requests;
  - `CLAUDE.md` (the `apps/api` bullet).

- [ ] **Step 1: Run the M1–M3 contract suites against the API, plus route parity, the matrix and the leak test.** Every case must pass, apart from the one Ruling 6 skips. A failure means fix the API; change a suite only if it contradicts the spec, then run the mock again.
- [ ] **Step 2: Run everything.** `pnpm lint && pnpm typecheck && pnpm test`, then push and confirm CI is green.
- [ ] **Step 3: App smoke test against the local API on the emulator.** Use `pnpm dev:db`, `db:migrate`, `db:seed`, `dev:api`, then Metro with `EXPO_PUBLIC_API_MODE=http` and `adb reverse tcp:3000 tcp:3000`.
  1. As Rajesh: create an order and assign a truck to Siltara.
  2. As Ravi: pull the task and mark it arrived. Then turn on airplane mode, capture tare and product weights, turn airplane mode off, and see it sync. Check Done today shows "Awaiting approval".
  3. As Rajesh: approve the truck in To approve and check the loading slip.
  4. As Kiran: the truck shows, with no ₹ anywhere.

  Record the outcome in the PR.
- [ ] **Step 4: Commit.** `test(api): M3 contract, permission matrix and money leak green against the real API`

---

### Task 10: Delivery (Ruling 11)

**Files:** `CHANGELOG.md` (`[Unreleased]`, B3), `apps/api/package.json` (`0.3.0`), `CLAUDE.md` (status line: B3 done; the `apps/api` bullet).

- [ ] **Step 1: Write the failing test:** the API's meta test expects `apiVersion` `0.3.0`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Bump the version and update the docs.**
- [ ] **Step 4: Run it and confirm it passes.** Then run `pnpm lint && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit.** `chore: B3 changelog, docs and apiVersion 0.3.0`

The finish (done by the controller, not a task): push, open the PR with the template filled in (including the smoke-test record), wait for `verify` to pass, merge with a merge commit, tag `b3` on it, and move the Notion B3 card to Completed.

## Research notes (why the risky parts are built this way)

- **Cursor safety.** An `updated_at` cursor skips rows when transactions commit out of order. The standard fixes are a snapshot-bounded cursor (`xid8` with `pg_snapshot_xmin(pg_current_snapshot())`), or serialising change versions per partition (Replicache's per-space version). The contract's date-time cursor rules out the first. Ruling 3 is the second, with the partition being the tenant. Sources: [Oskar Dudycz, ordering in a Postgres outbox](https://event-driven.io/en/ordering_in_postgres_outbox/), [a Stack Overflow question on missed updated rows](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/62603125/getting-newest-not-handled-updated-rows-using-txid), [Replicache: per-space version](https://doc.replicache.dev/strategies/per-space-version), [Replicache: backend strategies](https://doc.replicache.dev/strategies/overview).
- **Event idempotency.** Use the claim pattern: a unique `(tenant, event id)` with `INSERT … ON CONFLICT DO NOTHING RETURNING`, and apply effects only when this transaction made the claim. Check-then-insert races. Sources: [deduplicating with unique constraints](https://oneuptime.com/blog/post/2026-07-21-deduplicate-idempotency-unique-constraint/view), [an idempotent at-least-once consumer](https://oneuptime.com/blog/post/2026-07-21-idempotent-at-least-once-consumer/view).
- **Prior art in sync servers.** PowerSync ties write checkpoints to a source replication position, so the client knows its writes are reflected ([custom write checkpoints](https://docs.powersync.com/handling-writes/custom-write-checkpoints), [checkpoint requests](https://docs.powersync.com/client-sdks/advanced/checkpoint-requests)). Our per-event result, with the change-clock cursor, plays the same role without logical replication, which the free-tier Postgres may not offer.
- **Advisory locks were considered** for the fence (shared for writers, exclusive for the pull; [Postgres advisory lock modes](https://vladmihalcea.com/how-do-postgresql-advisory-locks-work)). The change-clock row does the same job, and also yields the strictly increasing time the cursor needs, so it replaces them.
