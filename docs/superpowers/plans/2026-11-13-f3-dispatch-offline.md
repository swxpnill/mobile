# F3 Dispatch & Offline Weighing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner and city staff assign trucks to sub-orders with a load plan, edit or cancel them, and watch every plant on a Dispatch board; supervisors weigh trucks (at gate → tare → gross + net split) **with or without network** on their phone, the phone syncs later, and the server dispatches the truck (loading slip number, broker earning, tolerance close). Rejected offline weights are never lost: the owner sees them under Needs attention and restores or dismisses them, and can correct a dispatched truck's weight. All against the mock API, proven by the contract suite.

**Architecture:** Truck rules are pure functions in `packages/shared/src/rules/trucks.ts` (state machine, net, pro-rata split, allocation check, plausibility, tolerance close, broker earning, slip number), used by the mock now, by B3 later, and by the phone for its own checks. `packages/mock-api` replaces the F2 minimal `TruckRec` with the full truck, weighment, rejection and broker-ledger records (store v4), adds truck/dispatch/supervisor/sync/rejection/correction routes, and does the dispatch as one transactional handler per sync event. The phone keeps a **device store** (expo-sqlite in the app, an in-memory implementation in tests) holding tasks, done-today and an **outbox**; a pure-TS sync engine pushes outbox events in `deviceSeq` order and pulls tasks by cursor, with backoff and clock-offset estimation. Screens: Assign/Edit vehicle, Dispatch board + detail, the supervisor app (My tasks, Tare, Gross + split, Dispatched, Done today), Needs attention, Correct weight.

**Tech Stack:** as F2. One new dependency: `expo-sqlite` (ships in Expo Go; install with `npx expo install expo-sqlite`). No other native modules.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md`: read §3, §4 Dispatch + Money (`broker_ledger`), §5.1 (incl. tolerance), §5.2, §5.3 numbering (loading slip), §5.4 broker earning, §5.5, §5.6, §5.7, all of §6, §7 trucks/supervisor/rejections + error contract, §8.1, §8.3 flows 2, 3, 10, §8.4 (Keypad, live region), §10.1, §10.3 scenarios 2 and 3, §11.1–4. UI and copy: design canvas https://claude.ai/artifact/1cf17fda-d3a4-498b-b46d-c67fdc49f795 boards 07 Assign vehicle (`AssignVehicle`), 08 Dispatch board (`Dispatch`), 09 Dispatch detail (`DispatchDetail`), 11 My tasks (`Queue`), 12 Capture weight (`Weighment`), 13 Dispatched (`Dispatched`), 34 Edit vehicle (`EditVehicle`), 35 Done today (`DoneToday`), 36 Tare (`TareWeight`), 02 Home "In plant now" (`Main`), 20 Transporter (`Transporter`). Read a board with the Artifact tool (`action: read`, `path: project/<Board>.dc.html`).

## Global Constraints

Everything in the F1 and F2 plans' Global Constraints still holds. In addition:

- Weights are integer kg everywhere (stored, sent, compared). The keypad input is parsed with `parseQtyInput` in the user's basis: MT keypad has a decimal key and allows max 3 decimals; kg keypad has no decimal key; max 7 characters either way.
- `net = gross − tare`; `net ≤ 0` → `INVALID_WEIGHT`; allocations must sum to **exactly** net (`ALLOC_MISMATCH`); every allocated line must be on the truck's sub-order (`LINE_REMOVED`).
- Plausibility (`net` vs Σ planned): `< 50 %` or `> 150 %` → second confirmation in the app; the server never blocks on it.
- Truck states and transitions: §5.2 diagram exactly. Gross and dispatch are one action ("Save gross · mark dispatched"); there is no "gross weighed" state (§11.1).
- Loading slip `LS-<CompanyCode>-YYMM-NNNN`: one series per company per financial year (IST), issued only by the server at dispatch, through the same `nextNumber` counter as orders (key `ls:<companyId>`).
- Broker earning per dispatched truck (only when the order has a broker): `roundHalfUp(Σ_lines netKg × (commissionPerMtSnapshot + overpricePerMt), 1000)`, rounded once per truck, with a per-line `breakdown`. 24.180 MT × (₹150 + ₹300) = ₹10,881. Fixed at dispatch; only a weight correction rewrites it (reversal row + new earning row).
- Tolerance close in the dispatch transaction: if after this truck `pending(subOrder) ≤ completionToleranceKg` (tenant setting, default 1000) and the sub-order has no other open truck, set each line's `closedKg = pending(line)` and `closeKind = 'tolerance'`, reason `"Within tolerance"`. A weight correction that pushes pending back above tolerance undoes it.
- Money never reaches the phone of a supervisor: task, done-today and sync payloads carry product names and kg only. Plant head and supervisor responses are redacted (new money keys: `earningRupees`, `breakdown`).
- Scope: plant head and supervisor see trucks whose `plantId ∈ user plants`; supervisor routes return only their plant's trucks; anything else is 404 (reads) or `PLANT_SCOPE` (sync events).
- Business time of a weighment is `capturedAt = capturedAtDevice + clockOffsetMs`; Done today and slip YYMM use it (IST). Skew > 5 min sets `clockSkewFlag`.
- Every write from the phone carries an `Idempotency-Key`; sync events are additionally de-duplicated by `clientEventId` (`duplicate` result).
- Saving a weight on the phone is one device-store transaction (outbox row + task local state); the UI says "Saved on this phone" only after it commits.
- Copy from the canvas boards listed above; status words: Assigned, At gate, Loading, Dispatched, Cancelled.

## Rulings (decided while planning: conflicts and gaps)

1. **Broker ledger rows are written in F3** (`BrokerLedgerRec`, earning and reversal kinds only) because dispatch and weight correction must write them in the same transaction. The ledger screens, payments and `GET /brokers/:id/ledger` are F4.
2. **One plant per company today** (seed). Assign shows a plant picker only when the company has more than one active plant; `plantId` is optional in the body and defaults to the only active plant (`PLANT_REQUIRED` 422 when there are several and none was sent).
3. **Tare correction:** a TARE event on a truck already in `loading` from the **same device** supersedes the previous tare (the supervisor fixed a typo); from a **different device** it is `TARE_CONFLICT` with the winning value, who and when. GROSS on a truck without tare → `TARE_REQUIRED` (cannot normally happen: the phone blocks later events of a truck after a rejection).
4. **Owner weighs from Dispatch detail** with the same capture screens; the event goes through the same outbox and sync endpoint (owner has `weighment.capture`). City staff and plant head cannot weigh (§5.5).
5. **Sync triggers in Expo Go:** on app foreground (`AppState`), every 60 s while the supervisor app is open, after every local save, and on the next success after a failure (backoff 2 s × 2ⁿ ± 20 % jitter, max 5 min). "Online" is not read from the OS; it is the result of the last request (simulated Offline in Demo tools therefore works). The Android periodic background task (§6.4) and silent push are deferred to the client build (F5).
6. **Device store:** interface `DeviceStore` with `createSqliteDeviceStore(db)` (expo-sqlite, used by the app) and `createMemoryDeviceStore()` (tests, web). One store per signed-in user (`tonnage-device-<userId>.db`). The SQLite implementation is a thin mapping proven by the shared `deviceStoreContract` cases run against the memory store in jest and checked on the emulator in Task 11.
7. **Pull is a full snapshot with tombstones**, cursor = server `changedAt` ISO of the newest change; `GET /v1/supervisor/tasks?cursor=` returns open trucks of my plant changed after the cursor plus `removed: truckId[]` (cancelled, dispatched elsewhere, re-planted). Without a cursor it returns every open truck. The phone replaces its task rows from the server and re-applies its own pending outbox events for display (§6.3).
8. **Needs attention** lives at More → Needs attention (owner only; a badge with the open count). Restore re-applies the stored events through the same dispatch code (reinstating a cancelled truck to `loading` when needed); dismiss needs a reason (≥ 3 characters). The notifications list is F5.
9. **Notifications on assign / dispatch / over-tolerance** are recorded as activity entries only; push and WhatsApp are F4/F5.
10. **Home "In plant now"** (deferred in F2 Ruling 6) and the Transporter "Trips this month / Recent vehicles" come with the Dispatch board task (Task 9), since they read the same truck views.
11. **Sign-out with unsynced weights** is blocked (§6.7): the sign-out row shows "2 weights not sent yet" and opens a sheet with "Send now" and "Sign out anyway" (type `SIGN OUT` to confirm; events stay in the user's device store). Switching person in Demo tools follows the same guard.

## Review Focus

1. **Supervisor saves tare offline, the owner cancels the truck, then the phone syncs** → TARE comes back `rejected TRUCK_CANCELLED`, the gross queued after it is `blocked` and not sent, both events appear once in Needs attention, Restore puts the truck back in `loading` with that tare and dispatches it with that gross. (Task 5 + Task 6 contract, Task 7 engine test)
2. **The same outbox is pushed twice (app killed after the server committed, before the phone marked it accepted)** → second push returns `duplicate` for every event; one weighment, one slip number, one ledger earning. (Task 5 contract)
3. **Gross that leaves the sub-order within 1 MT of done while another truck of the same sub-order is still loading** → no tolerance close yet; it closes when that last truck dispatches; a weight correction that reopens > 1 MT pending undoes the tolerance close and the order shows Partly dispatched again. (Task 1 unit + Task 5/6 contract)
4. **Plant head of Siltara opens the Dispatch board or a truck of another plant** → only Siltara trucks are listed; another plant's truck is 404; no money key anywhere (incl. broker earning in truck detail). Supervisor sync for a truck of another plant → `rejected PLANT_SCOPE`. (Task 4 + Task 5 contract)
5. **Kg-basis supervisor types a weight / MT-basis supervisor types 4 decimals** → kg keypad has no decimal key; MT keypad refuses a 4th decimal and an 8th character; both store the same integer kg. (Task 8 component test)

---

### Task 1: Shared truck rules

**Files:**
- Create: `packages/shared/src/rules/trucks.ts`, `packages/shared/src/rules/trucks.test.ts`
- Modify: `packages/shared/src/rules/index.ts`, `packages/shared/src/rules/numbering.ts` (+ `numbering.test.ts`)

**Interfaces:**
- Produces:
  - `type TruckEvent = 'at_gate' | 'tare' | 'gross' | 'cancel'`; `nextTruckState(state: TruckState, event: TruckEvent): TruckState | null`: `assigned→at_gate` (at_gate), `assigned|at_gate→loading` (tare), `loading→loading` (tare, a correction), `loading→dispatched` (gross), any non-terminal → `cancelled` (cancel); `null` = not allowed.
  - `netKg(grossKg: number, tareKg: number): number`
  - `splitProRata(netKg: number, plan: { orderLineId: string; plannedKg: number }[]): { orderLineId: string; netKg: number }[]`: largest-remainder method on integer kg, ties broken by plan order; sums exactly to `netKg`; a single plan line gets all of it; an all-zero plan splits evenly.
  - `checkAllocations(netKg: number, allocations: { orderLineId: string; netKg: number }[], lineIds: ReadonlySet<string>): 'ok' | 'ALLOC_MISMATCH' | 'LINE_REMOVED' | 'INVALID_WEIGHT'`: `INVALID_WEIGHT` when `netKg ≤ 0` or any allocation < 0.
  - `plausibility(netKg: number, plannedKg: number): 'ok' | 'low' | 'high'`: `low` when `netKg × 2 < plannedKg`, `high` when `netKg × 2 > plannedKg × 3`, `ok` when `plannedKg = 0`.
  - `toleranceCloseKg(lines: LineQty[], toleranceKg: number, otherOpenTrucks: number): number[] | null`: per-line `closedKg` to set (`pending(l)` each) when Σ pending ≤ tolerance and `otherOpenTrucks = 0` and some line has dispatched > 0, else `null`.
  - `overToleranceKg(lines: LineQty[], toleranceKg: number): number`: `Σ over(l)` when it exceeds tolerance, else 0.
  - `truckEarning(allocations: { orderLineId: string; netKg: number }[], lines: ReadonlyMap<string, { overpricePerMt: number }>, commissionPerMt: number): { earningRupees: number; breakdown: { orderLineId: string; netKg: number; perMt: number }[] }`.
  - `CLOCK_SKEW_FLAG_MS = 300_000`; `TRUCK_CANCEL_REASONS = ['Vehicle did not arrive', 'Order short closed', 'Wrong vehicle', 'Other'] as const`.
  - In `numbering.ts`: `formatLoadingSlip(companyCode: string, at: string | number, seq: number): string`, giving `LS-KRM-2611-0007`.

- [ ] **Step 1: Write the failing tests** (`trucks.test.ts`)

```ts
it('canvas earning: 24.180 MT × (₹150 + ₹300) = ₹10,881', () => {
  const lines = new Map([['l1', { overpricePerMt: 300 }]]);
  expect(truckEarning([{ orderLineId: 'l1', netKg: 24_180 }], lines, 150).earningRupees).toBe(10_881);
});
it('splits 24.180 MT over plans 16 + 8 MT exactly, largest remainder', () => {
  const a = splitProRata(24_180, [{ orderLineId: 'a', plannedKg: 16_000 }, { orderLineId: 'b', plannedKg: 8_000 }]);
  expect(a).toEqual([{ orderLineId: 'a', netKg: 16_120 }, { orderLineId: 'b', netKg: 8_060 }]);
});
it('property: splitProRata always sums to net and never goes negative', () => { /* fast-check over net 1…10^7 and 1–5 plan lines */ });
it('state machine: gross only from loading; at gate optional; cancel from any open state', () => {
  expect(nextTruckState('assigned', 'tare')).toBe('loading');
  expect(nextTruckState('assigned', 'gross')).toBeNull();
  expect(nextTruckState('dispatched', 'cancel')).toBeNull();
});
it('plausibility 50 % / 150 % boundaries are ok, beyond them low / high', () => {
  expect(plausibility(12_000, 24_000)).toBe('ok');
  expect(plausibility(11_999, 24_000)).toBe('low');
  expect(plausibility(36_001, 24_000)).toBe('high');
});
it('tolerance close waits for the last open truck (Review Focus 3)', () => {
  const lines = [{ orderedKg: 24_000, dispatchedKg: 23_400, closedKg: 0, reservedKg: 0 }];
  expect(toleranceCloseKg(lines, 1_000, 1)).toBeNull();
  expect(toleranceCloseKg(lines, 1_000, 0)).toEqual([600]);
});
it('checkAllocations: off by one kg → ALLOC_MISMATCH; unknown line → LINE_REMOVED', () => { … });
```

`numbering.test.ts`: `formatLoadingSlip('KRM', '2026-11-03T04:30:00Z', 7)` → `'LS-KRM-2611-0007'`; on 31 Mar 23:50 IST the month is `2603`.

- [ ] **Step 2: Run, expect FAIL.** Run: `pnpm --filter @tonnage/shared exec vitest run src/rules`
- [ ] **Step 3: Implement** `trucks.ts` (reuse `roundHalfUp`, `pending`, `over` from `money.ts`/`quantities.ts`) and `formatLoadingSlip` (reuse `istDateParts`).
- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @tonnage/shared typecheck`.
- [ ] **Step 5: Commit** `feat(shared): truck rules: state machine, split, plausibility, tolerance, earning, slip number`

---

### Task 2: Shared schemas, errors, policy and money keys for dispatch

**Files:**
- Create: `packages/shared/src/schemas/trucks.ts` (+ `trucks.test.ts`)
- Modify: `packages/shared/src/schemas/index.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/policy.ts` (+ test), `packages/shared/src/redact.ts` (+ test), `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `truckStateSchema`, `idSchema`, `versionSchema` (orders.ts), `TRUCK_CANCEL_REASONS` (Task 1).
- Produces (schemas and inferred types of the same name without `Schema`):
  - `weightKgSchema = z.number().int().min(1).max(100_000)` (one weighbridge reading, ≤ 100 t); `planKgSchema = orderedKgSchema`.
  - `vehicleNoSchema`: trimmed, upper-cased, single spaces, 4–15 chars of `[A-Z0-9 ]`.
  - `driverPhoneSchema`: Indian mobile, normalised `+91XXXXXXXXXX` (reuse the party number normaliser).
  - `loadPlanRowSchema { orderLineId, plannedKg: planKgSchema }`, `assignTruckBodySchema { plantId?: id, vehicleNo, transporterId: id | null, driverName (1–60), driverPhone, lrNo: string(≤ 30) | null, plan: loadPlanRow[] (1–20, unique lines) }`.
  - `editTruckBodySchema` = all of assign except `plantId`, all optional, plus `version`; `plan` only allowed while state ∈ assigned|at_gate|loading (server enforces `TRUCK_LOCKED`).
  - `cancelTruckBodySchema { reason: enum TRUCK_CANCEL_REASONS, note: string ≤ 200, version }`.
  - `truckSchema { id, subOrderId, subOrderNumber, orderId, customerName: string | null, companyId, companyCode, plantId, plantName, vehicleNo, transporter: {id,name} | null, driverName, driverPhone, lrNo, state, plan: {orderLineId, productName, length, plannedKg}[], tareKg|null, grossKg|null, netKg|null, allocations: {orderLineId, netKg}[], loadingSlipNo|null, assignedAt, assignedBy: {id,name}, atGateAt|null, tareAt|null, dispatchedAt|null, cancelledAt|null, cancelReason|null, earningRupees?: number, weighments: {id, kind: 'tare'|'gross', kg, by: {id,name}, capturedAt, superseded: boolean, clockSkew: boolean}[], warnings?: ('VEHICLE_BUSY'|'OVER_ASSIGNABLE')[], version }`.
  - `dispatchBoardSchema { counts: Record<'assigned'|'at_gate'|'loading'|'dispatched_today', number>, items: truckSchema[] }` (items without `weighments`; use `truckSchema.omit`).
  - `taskSchema` (phone, no money, no customer money): `{ truckId, vehicleNo, transporterName|null, driverName, driverPhone, customerName|null, subOrderNumber, companyCode, state, tareKg|null, tareDeviceId|null, plan: {orderLineId, productName, plannedKg}[], version, changedAt }`; `tasksPageSchema { items: task[], removed: id[], cursor: string, serverTime: string }`; `doneTodaySchema { items: { truckId, vehicleNo, customerName|null, subOrderNumber, netKg, loadingSlipNo, dispatchedAt }[], totalNetKg }`.
  - `syncEventSchema` (discriminated on `type`): `{ eventId: id, truckId: id, deviceSeq: int ≥ 0, capturedAtDevice: ISO, type: 'AT_GATE' }`, `… type: 'TARE', tareKg: weightKg }`, `… type: 'GROSS', grossKg: weightKg, allocations: {orderLineId, netKg: int ≥ 0}[] (1–20) }`; `syncBodySchema { deviceId: string(8–64), events: syncEvent[] (1–100) }`.
  - `syncResultSchema` (discriminated on `status`): `accepted { eventId, task: taskSchema | null, loadingSlipNo?: string }`, `duplicate { eventId }`, `rejected { eventId, code: SyncRejectCode, message, server?: { tareKg?, by?, at?, state? } }`; `syncResponseSchema { results, serverTime }`.
  - `SYNC_REJECT_CODES = ['PLANT_SCOPE','TARE_CONFLICT','TRUCK_CANCELLED','INVALID_WEIGHT','ALLOC_MISMATCH','LINE_REMOVED','TARE_REQUIRED','ALREADY_DISPATCHED','INVALID_STATE'] as const`.
  - `rejectionSchema { id, truckId, vehicleNo, subOrderNumber, plantName, user: {id,name}, eventType, payload (kg fields only), code, serverState, status: 'open'|'restored'|'dismissed', createdAt, resolvedBy|null, resolutionNote|null }`; `dismissRejectionBodySchema { reason: string 3–200 }`.
  - `correctWeightBodySchema { tareKg: weightKg, grossKg: weightKg, allocations, reason: string 3–200, version }`.
- Errors: add `PLANT_REQUIRED`, `PLANT_INACTIVE`, `CUSTOMER_REQUIRED`, `TRUCK_LOCKED`, `TRUCK_CANCELLED`, `ALREADY_RESOLVED` plus every `SYNC_REJECT_CODES` member. User copy for each goes in the app's `messageFor` (`apps/mobile/src/screens/messages.ts`, done in Task 9 for truck codes and Task 8 for sync codes), e.g. `CUSTOMER_REQUIRED`: "Add a customer to this order before assigning a vehicle".
- `subOrderSchema` (orders.ts) gains `overToleranceKg: z.number().int()` (`overToleranceKg(lines, tolerance)`, 0 when within); order detail shows "+X MT over" in amber when > 0 (Task 9).
- Policy: add action `rejections.manage` (owner only); `truck.view` is covered by `dispatch.view`. Update the owner/plant head "can / cannot" text only if a test pins it.
- `MONEY_KEYS` += `earningRupees`, `breakdown`.

- [ ] **Step 1: Failing tests:** `vehicleNoSchema.parse(' cg04mk  2291 ')` → `'CG04MK 2291'`; assign body refuses duplicate `orderLineId` in `plan`; `syncBodySchema` refuses 101 events; a GROSS event without allocations is a 422; `redactForRole('plant_head', { earningRupees: 1, breakdown: [] })` → `{}`; policy matrix: `rejections.manage` only owner.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/shared exec vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(shared): dispatch and sync schemas, error codes, rejections policy`

---

### Task 3: Mock store v4, dispatch math and demo seed trucks

**Files:**
- Modify: `packages/mock-api/src/store.ts` (`SNAPSHOT_VERSION = 4`), `orders-math.ts`, `trucks.ts`, `seed-orders.ts`, `fixtures.ts`, `controls.ts`, `index.ts`
- Create: `packages/mock-api/src/truck-views.ts`, `packages/mock-api/src/dispatch.ts` (+ `dispatch.test.ts`)

**Interfaces:**
- Produces:
  - `TruckRec` gains `orderId, transporterId: string|null, driverName, driverPhone, lrNo: string|null, assignedAt, assignedBy, atGateAt, tareAt, tareDeviceId, grossKg, loadingSlipNo, cancelledBy` (all nullable where not yet known). F2 fields keep their names.
  - `WeighmentRec { id, tenantId, truckId, kind: 'tare'|'gross', kg, enteredBy, deviceId, clientEventId, capturedAtDevice, capturedAt, receivedAt, clockSkewFlag, supersededBy: string|null }`.
  - `RejectionRec { id, tenantId, clientEventId, truckId, userId, deviceId, event: SyncEvent, code, serverState, status, createdAt, resolvedBy, resolvedAt, resolutionNote }`.
  - `BrokerLedgerRec { id, tenantId, brokerId, kind: 'earning'|'reversal', truckId, amountRupees, breakdown, reversesId: string|null, createdAt, createdBy }`.
  - `MockState` += `weighments`, `rejections`, `brokerLedger`, `appliedEvents: Record<clientEventId, SyncResult>`.
  - `dispatch.ts`: `applyEvent(state: MockState, ctx: { user: Authed; deviceId: string; now: number; offsetMs: number }, event: SyncEvent): SyncResult`: the whole §6.5 table in one function, writing weighments, state, allocations, slip number, ledger earning, tolerance close and activity. Throws nothing for business refusals (returns `rejected`); the caller wraps each event in the transactional snapshot (Task 5).
  - `reverseEarning(state, truck, at, actorId): void` and `writeEarning(state, truck, at, actorId): void` (Task 6 reuses them).
  - `truck-views.ts`: `toTruck(c: OrderCtx, t: TruckRec, opts: { withWeighments: boolean }): Truck`, `toTask(state, t): Task`.
  - Seed (`seedOrders: true`): the five demo orders gain realistic trucks: on Siltara (AIP), one `assigned`, one `at_gate`, one `loading` with tare 12.460 t (CG 04 MK 2291 · Shree Ganesh Roadlines · Ramesh Yadav, canvas 11), dispatched trucks with weighments, slip numbers and ledger earnings consistent with their allocations. The other plants get one open truck each.
- Contract fixtures: `addTruck` keeps its signature (still used by F2 contract tests) and fills the new fields with defaults; a dispatched fixture truck gets a slip number and, when the order has a broker, an earning row.

- [ ] **Step 1: Failing tests (`dispatch.test.ts`, store-level, no HTTP):** TARE then GROSS on the seeded loading truck → state `dispatched`, slip `LS-AIP-2611-000N`, one earning row equal to `truckEarning(...)`; GROSS whose net is 0 → `rejected INVALID_WEIGHT` and state unchanged; a snapshot from version 3 is discarded on load (reseeds).
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/mock-api exec vitest run`
- [ ] **Step 3: Implement** store v4 + `dispatch.ts` + views + seed. `orderMath.lineQty` keeps reading allocations of dispatched trucks only and plans of open trucks.
- [ ] **Step 4: Run all mock-api and contract tests, expect PASS** (F2 suites unchanged): `pnpm --filter @tonnage/mock-api test && pnpm --filter @tonnage/contract-tests test`
- [ ] **Step 5: Commit** `feat(mock-api): store v4 with trucks, weighments, rejections, broker earnings; dispatch core`

---

### Task 4: Truck API: assign, edit, cancel, detail, dispatch board

**Files:**
- Create: `packages/mock-api/src/handlers/trucks.ts`, `packages/contract-tests/src/suites/trucks.contract.ts`
- Modify: `packages/mock-api/src/router.ts` (register), `packages/contract-tests/src/suites/index.ts` (`CONTRACT_SUITES`), `packages/mock-api/src/handlers/home.ts`, `handlers/parties.ts` (transporter stats)

**Interfaces:**
- Consumes: Task 2 schemas, Task 3 records and `toTruck`.
- Produces routes (all `transactional: true` for writes, idempotency like orders):
  - `POST /v1/sub-orders/:id/trucks` (`truck.assign`) → 201 `Truck` with `warnings`. Guards in order: sub-order visible (404), not terminal (`ORDER_LOCKED`), order has a customer (`CUSTOMER_REQUIRED`), company active (`COMPANY_INACTIVE`), plant resolved and active (`PLANT_REQUIRED` 422 / `PLANT_INACTIVE` 409), each plan line on this sub-order (`LINE_NOT_ON_ORDER` with `details.lineId`). Warnings: `VEHICLE_BUSY` (same `vehicleNo` on another open truck), `OVER_ASSIGNABLE` (plan > assignable on any line). Activity `truck.assigned`.
  - `PATCH /v1/trucks/:id` (`truck.edit`) → `Truck`; vehicle/driver/transporter/LR editable in any non-cancelled state (LR also after dispatch); `plan` only before dispatch (`TRUCK_LOCKED`); `version` checked (`STALE`).
  - `POST /v1/trucks/:id/cancel` (`truck.cancel`) → `Truck`; dispatched or cancelled → `TRUCK_LOCKED`; releases the plan; keeps weighments. Activity `truck.cancelled`.
  - `GET /v1/trucks/:id` (`dispatch.view`) → `Truck` with `weighments`; out of plant scope → 404.
  - `GET /v1/dispatch?companyId=&state=open|assigned|at_gate|loading|dispatched_today&q=` (`dispatch.view`) → `DispatchBoard`; `q` matches vehicle, order number, customer; sorted loading → at gate → assigned → dispatched today (newest first); plant scope applied.
  - `GET /v1/trucks/recent-vehicles` (`truck.assign`) → `{ vehicleNo, transporterId, driverName, driverPhone }[]`, the 8 most recently assigned distinct vehicles of the tenant.
  - Home gains `inPlant: { truckId, vehicleNo, companyCode, state, plannedKg }[]` (open trucks, scope-filtered); transporter detail gains `stats: { tripsThisMonth, vehiclesSeen, recentVehicles: string[] }`.

- [ ] **Step 1: Failing contract tests** (`trucks.contract.ts`): canvas assign (SO-…-A, CG 04 MK 2291, 24.000 MT of TMT 12 mm · 12 m) → 201, `state: 'assigned'`, `reservedKg` on the line +24,000; broker-only order → 409 `CUSTOMER_REQUIRED`; plan line of sub-order B on A → 409 `LINE_NOT_ON_ORDER`; same vehicle twice → second has `warnings: ['VEHICLE_BUSY']`; double POST with one key → one truck; cancel → reserved back to 0, then edit → 409 `TRUCK_LOCKED`; **Review Focus 4**: Kiran (plant head, Siltara) board lists only Siltara trucks, `GET` a Borai truck → 404, no money key in any response (move `moneyKeysIn` from `orders.contract.ts` into `harness.ts` and assert it is empty); Ravi (supervisor) `GET /v1/dispatch` → 403.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/contract-tests exec vitest run -t "trucks"`
- [ ] **Step 3: Implement** the handlers and view changes.
- [ ] **Step 4: Run the whole contract suite, expect PASS.**
- [ ] **Step 5: Commit** `feat(mock-api): assign, edit and cancel trucks; dispatch board; in-plant trucks on Home`

---

### Task 5: Supervisor tasks, done today and `weighments/sync`

**Files:**
- Create: `packages/mock-api/src/handlers/supervisor.ts`, `packages/contract-tests/src/suites/sync.contract.ts`
- Modify: `packages/mock-api/src/router.ts`, `packages/mock-api/src/pipeline.ts` (per-event transaction helper), mock transport response headers (`date`), `CONTRACT_SUITES`

**Interfaces:**
- Consumes: `applyEvent` (Task 3).
- Produces:
  - `GET /v1/supervisor/tasks?cursor=` (`tasks.view`) → `TasksPage` per Ruling 7, plant scope = the supervisor's plant(s).
  - `GET /v1/supervisor/done-today` (`tasks.view`) → `DoneToday` (trucks of my plant whose gross `capturedAt` is today IST).
  - `POST /v1/weighments/sync` (`weighment.capture`, **not** route-transactional; each event runs in its own snapshot/rollback via `runEventTransaction(state, fn)`) → `SyncResponse` in the request's order. Before applying: `clientEventId` already in `appliedEvents` → `duplicate`. After a `rejected` result: copy to `rejections` (status `open`), and every later event **in the same request** for the same truck → `rejected INVALID_STATE` with message "Blocked by an earlier rejected weight" (the phone normally stops sending them). Clock offset: `offsetMs = receivedAt − max(capturedAtDevice of the batch)` is not trusted; use `capturedAt = capturedAtDevice + (serverNow − deviceNowHeader)` from header `X-Device-Time` when present, else `capturedAtDevice`; set `clockSkewFlag` when |offset| > `CLOCK_SKEW_FLAG_MS`.
  - Every response carries a `date` header (server time) so the phone can estimate its offset.

- [ ] **Step 1: Failing contract tests** (`sync.contract.ts`):
  - Ravi syncs AT_GATE, TARE 12,460, GROSS 36,640 with one allocation 24,180 for the seeded truck → three `accepted`, the last has `loadingSlipNo` matching `/^LS-AIP-\d{4}-\d{4}$/`; owner's order detail shows dispatched +24,180; ledger has one earning ₹10,881 when commission 150 + overprice 300.
  - **Review Focus 2**: the same body again → three `duplicate`; still one weighment per kind, one slip, one earning.
  - Second device sends TARE for a truck already tared → `rejected TARE_CONFLICT` with `server.tareKg`, `server.by`, `server.at`; same device → accepted, old weighment `superseded`.
  - Allocation off by 1 kg → `ALLOC_MISMATCH`; allocation to a line removed by an edit → `LINE_REMOVED`; truck cancelled before sync → `TRUCK_CANCELLED` and the following GROSS in the batch is rejected `INVALID_STATE`; both appear in `GET /v1/weighment-rejections` (owner) once each.
  - Sanjay (Borai) syncs a Siltara truck → `PLANT_SCOPE`; Sanjay's `/supervisor/tasks` never lists Siltara trucks; no money keys in tasks, done-today or sync responses.
  - Tolerance (**Review Focus 3**): two trucks on a 24 MT line; the first dispatches 23.4 MT while the second is loading → sub-order `partly_dispatched`; cancel the second → still partly dispatched (no dispatch happened); assign and dispatch a third with 0.2 MT net → `completed` with `closeKind: 'tolerance'`.
  - Cursor: pull, cancel one truck, pull with the cursor → `removed` contains it, `items` excludes it.
  - Captured 23:50 IST, synced 00:40 IST next day → done-today of the earlier day contains it (fake clock).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all contract + mock tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(mock-api): supervisor tasks, done today, weighment sync with conflicts and rejections`

---

### Task 6: Needs attention and weight correction API

**Files:**
- Create: `packages/mock-api/src/handlers/rejections.ts`, `packages/contract-tests/src/suites/rejections.contract.ts`
- Modify: `packages/mock-api/src/handlers/trucks.ts` (correct-weight), router, `CONTRACT_SUITES`

**Interfaces:**
- Consumes: `applyEvent`, `writeEarning`, `reverseEarning` (Task 3).
- Produces:
  - `GET /v1/weighment-rejections?status=open|all` (`rejections.manage`) → `Rejection[]` newest first; `GET /v1/weighment-rejections/count` → `{ open: number }`.
  - `POST /v1/weighment-rejections/:id/restore` (`rejections.manage`, transactional): if the truck is cancelled, reinstate it to the state its weighments imply (no tare → `assigned`; tare → `loading`) and re-reserve its plan; then re-run the stored event with `applyEvent` as the original user/device; if that is rejected again → 409 with that code and the rejection stays open; on success → status `restored`, returns `{ rejection, truck }`. Restoring a rejection whose later sibling (same truck, blocked) is also open restores them in `deviceSeq` order in one call.
  - `POST /v1/weighment-rejections/:id/dismiss` (`rejections.manage`) `{ reason }` → status `dismissed`; resolved twice → 409 `ALREADY_RESOLVED`.
  - `POST /v1/trucks/:id/correct-weight` (`weighment.correctAfterDispatch`, transactional) body `correctWeightBody` → `Truck`: only `dispatched` (`TRUCK_LOCKED` otherwise); supersedes both weighments with new ones (`deviceId: 'server'`), replaces allocations, reverses the old earning and writes a new one from the truck's original snapshot rates, re-evaluates tolerance (undo when pending > tolerance; close when ≤ and no open trucks), activity `truck.weight_corrected` with old and new net.
  - In `applyEvent` (Task 3) a GROSS that makes `overToleranceKg > 0` logs activity `order.over_tolerance` with the kg (push to the owner is F5).

- [ ] **Step 1: Failing contract tests:** **Review Focus 1** end-to-end: tare offline, owner cancels the truck, sync → TARE `TRUCK_CANCELLED`, GROSS `INVALID_STATE`; owner restores the first → truck `dispatched` with both weights, one slip, both rejections `restored`; dismiss needs ≥ 3 chars (422) and twice → `ALREADY_RESOLVED`; city staff `GET /v1/weighment-rejections` → 403. Correction: dispatched 24.180 → corrected net 22.000 MT → ledger has earning, reversal (exact negation) and new earning, Σ = new earning; a tolerance-completed sub-order corrected down by 2 MT is `partly_dispatched` again with `closeKind: null`; city staff correct → 403.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all contract + mock tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(mock-api): needs attention (restore, dismiss) and owner weight correction`

---

### Task 7: Phone device store and sync engine

**Files:**
- Create: `apps/mobile/src/offline/deviceStore.ts` (interface + memory impl), `apps/mobile/src/offline/sqliteDeviceStore.ts`, `apps/mobile/src/offline/syncEngine.ts`, `apps/mobile/src/offline/backoff.ts`, `apps/mobile/src/offline/useSync.ts` (React hook + Zustand status store), `apps/mobile/test/device-store.test.ts`, `apps/mobile/test/sync-engine.test.ts`
- Modify: `apps/mobile/package.json` (`expo-sqlite` via `npx expo install expo-sqlite`), `apps/mobile/src/api/client.ts` (expose response `date` header and send `X-Device-Time`)

**Interfaces:**
- Consumes: `Task`, `SyncEvent`, `SyncResult`, `TasksPage`, `DoneToday` schemas (Task 2); `api()`.
- Produces:
  - `OutboxRow { eventId, truckId, type: 'AT_GATE'|'TARE'|'GROSS', payload: { tareKg?: number; grossKg?: number; allocations?: {orderLineId, netKg}[] }, capturedAtDevice: string, deviceSeq: number, status: 'pending'|'sending'|'accepted'|'rejected'|'blocked', attempts: number, error: { code: string; message: string } | null, acceptedAt: string | null }`.
  - `interface DeviceStore { getTasks(): Promise<Task[]>; replaceTasks(page: TasksPage): Promise<void>; getDoneToday(): Promise<DoneToday | null>; setDoneToday(d: DoneToday): Promise<void>; saveCapture(row: Omit<OutboxRow,'deviceSeq'|'status'|'attempts'|'error'|'acceptedAt'>): Promise<OutboxRow>; outbox(filter?: { status?: OutboxRow['status'][] }): Promise<OutboxRow[]>; markResults(results: SyncResult[]): Promise<void>; requeue(eventIds: string[]): Promise<void>; purgeAccepted(olderThanMs: number, now: number): Promise<number>; meta(): Promise<SyncMeta>; setMeta(m: Partial<SyncMeta>): Promise<void>; clear(): Promise<void> }`, `SyncMeta { cursor: string | null; clockOffsetMs: number; lastSyncAt: string | null; nextDeviceSeq: number; deviceId: string }`.
  - `saveCapture` assigns `deviceSeq = nextDeviceSeq++` and status `pending` in **one transaction**; `markResults` sets `accepted`/`duplicate→accepted`/`rejected`, and every later `pending` row of a rejected truck → `blocked`.
  - `displayTasks(tasks: Task[], outbox: OutboxRow[]): Task[]`: server tasks with pending local events applied (at gate → `at_gate`, tare → `loading` + `tareKg`, gross → removed from the list), plus a `localPending: boolean` flag.
  - `createSyncEngine(deps: { store: DeviceStore; push(body: SyncBody): Promise<{ results: SyncResult[]; serverDate: string | null }>; pull(cursor: string | null): Promise<TasksPage>; pullDoneToday(): Promise<DoneToday>; now(): number; random(): number }): { syncNow(): Promise<SyncOutcome>; nextDelayMs(failures: number): number }` with `SyncOutcome = { ok: boolean; sent: number; rejected: number; pendingLeft: number; error?: 'network' | 'auth' | 'server' }`. Push sends `pending` rows (oldest `deviceSeq` first, max 100 per request, `sending` while in flight, back to `pending` on network error), then pulls.
  - `backoff(failures, random) = min(300_000, 2_000 × 2^failures) × (0.8 + 0.4 × random)`.
  - `useSyncStatus()` (Zustand): `{ online: boolean | null; pending: number; rejected: number; lastSyncAt; syncing }`; `useSync()` starts the loop for supervisor/owner sessions (AppState foreground, 60 s interval, after save) and stops on sign-out.
  - `openDeviceStore(userId: string): Promise<DeviceStore>`: SQLite on native, memory on web/jest.

- [ ] **Step 1: Failing tests** with the memory store and fake push/pull:
  - `saveCapture` ×3 gets `deviceSeq` 0, 1, 2; a thrown error inside the transaction leaves no row.
  - Engine: push fails with a network error → rows back to `pending`, `attempts` +1, outcome `{ ok: false, error: 'network' }`; next run succeeds → `accepted`, `pendingLeft: 0`.
  - TARE rejected `TRUCK_CANCELLED` → the GROSS of the same truck is `blocked` and **not** in the next push body; a GROSS of another truck still goes (**Review Focus 1**).
  - `duplicate` is treated as accepted.
  - `displayTasks` shows a truck with a pending local TARE as loading with that tare, and hides one with a pending GROSS.
  - `nextDelayMs` stays within 1.6 s…2.4 s at 0 failures and never exceeds 300 s.
  - Clock offset: server date 10 min ahead of `now()` → meta `clockOffsetMs ≈ 600_000`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter mobile exec jest test/device-store.test.ts test/sync-engine.test.ts`
- [ ] **Step 3: Implement**; the SQLite store uses `openDatabaseAsync`, `execAsync` (schema: `tasks`, `done_today`, `outbox`, `sync_meta` as §6.2) and `withExclusiveTransactionAsync` for `saveCapture`/`markResults`.
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter mobile typecheck`.
- [ ] **Step 5: Commit** `feat(mobile): device store (SQLite) and outbox sync engine`

---

### Task 8: Supervisor app: My tasks, tare, gross + split, dispatched, done today

**Files:**
- Create: `apps/mobile/src/ui/Keypad.tsx` (+ `WeightReadout`), `apps/mobile/src/screens/supervisor/{TasksScreen,CaptureScreen,SplitStep,DispatchedScreen,DoneTodayScreen,SyncBanner,SignOutGuardSheet}.tsx`, `apps/mobile/app/(app)/weigh/[truckId].tsx`, `apps/mobile/app/(app)/dispatched/[truckId].tsx`, `apps/mobile/test/supervisor.test.tsx`, `apps/mobile/test/keypad.test.tsx`
- Modify: `app/(app)/(tabs)/tasks.tsx`, `done.tsx` (replace placeholders), `src/screens/SignOutRow.tsx` (guard), `src/screens/DemoToolsScreen.tsx` (person switch guard), `src/ui/index.ts`

**Interfaces:**
- Consumes: Task 7 (`useSync`, `openDeviceStore`, `displayTasks`), Task 1 (`netKg`, `splitProRata`, `checkAllocations`, `plausibility`), `parseQtyInput`/`toDisplayQty`.
- Produces:
  - `Keypad({ value, onChange, basis }: { value: string; onChange(v: string): void; basis: UnitBasis })`: 3×4 grid; decimal key only for `mt`; refuses a 4th decimal and an 8th character; Delete key labelled "Delete".
  - `CaptureScreen({ truckId, mode: 'tare' | 'gross' })`: canvas 36 (tare, violet) / 12 (gross, blue). Gross shows Gross, "Tare · weighed HH:mm" (red, minus), Net loaded (green), and the plan difference row ("+0.180 over · allowed" amber / "−0.420 under · allowed" red / "Exact" green). Readout has `accessibilityLiveRegion="polite"`. Plausibility `low|high` → `ConfirmSheet` "Net is 38 % of the plan. Save anyway?". More than one plan line → `SplitStep` (prefilled with `splitProRata`, one input per line, live "Left to allocate"; Save disabled until the sum equals net). Save writes the outbox (`saveCapture`), then says **"Saved on this phone"** and triggers a sync.
  - `TasksScreen`: canvas 11: plant name header, `SyncBanner` (amber "No network · N weights saved on this phone · they sync automatically" / red "N weights need the owner" when rejected rows exist / nothing when all is synced), the three counts (Need tare · Need gross · Done today), task cards with state badge and the primary action (At gate → "Capture tare weight"; Loading → "Capture gross weight"; an "At gate" secondary action for assigned trucks). Pull to refresh = `syncNow`.
  - `DispatchedScreen`: canvas 13: shows net, slip number when synced ("Loading slip LS-…") or "Waiting for network" while pending.
  - `DoneTodayScreen`: canvas 35, from the device store, total net.

- [ ] **Step 1: Failing tests:**
  - `keypad.test.tsx` (**Review Focus 5**): MT: typing `3`,`6`,`.`,`6`,`4`,`0`,`5` → value `36.640` (5th decimal refused); kg keypad has no "Decimal point" key; 8th character refused.
  - `supervisor.test.tsx` with the mock API (Ravi) and the memory device store: tasks show CG 04 MK 2291 "Tare 12.460 t"; capture gross 36.640 → net 24.180 shown, "Exact" against a 24.000 plan shows "+0.180 over · allowed"; Save → "Saved on this phone", the outbox has one GROSS row; with Demo tools Offline on, the banner says "No network · 1 weight saved on this phone"; Offline off + sync → Dispatched shows the slip number. Two-line plan: Save disabled until the split sums to net. Implausible net (10 t of 24) → confirmation before saving. Sign out with one pending row → guard sheet, not signed out.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; lint + typecheck.
- [ ] **Step 5: Commit** `feat(mobile): supervisor app — tasks, tare, gross with split, dispatched, done today, offline banner`

---

### Task 9: Assign / edit vehicle, Dispatch board and detail

**Files:**
- Create: `apps/mobile/src/api/hooks/trucks.ts`, `apps/mobile/src/screens/dispatch/{DispatchScreen,TruckCard,TruckDetailScreen,AssignVehicleScreen,CancelTruckSheet,truckStateMeta}.tsx`, `apps/mobile/app/(app)/trucks/[id].tsx`, `apps/mobile/app/(app)/assign/[subOrderId].tsx`, `apps/mobile/test/dispatch.test.tsx`
- Modify: `app/(app)/(tabs)/dispatch.tsx` (replace placeholder), `src/screens/orders/OrderDetailScreen.tsx` (+ `OrderActionsSheet`: "Assign vehicle" per sub-order, truck rows link to detail), `src/screens/home/*` ("In plant now" section), `src/screens/parties/PartyDetailScreen.tsx` (transporter stats), `src/api/hooks/orders.ts` (`afterOrderChange` also invalidates dispatch keys)

**Interfaces:**
- Consumes: Task 4 routes; `useUnitFilter` (board key includes `companyId`); Task 8 `CaptureScreen` (owner weighs from detail, Ruling 4).
- Produces:
  - Hooks: `useDispatchBoard(f: { state; q })`, `useTruck(id)`, `useRecentVehicles()`, `useAssignTruck()`, `useEditTruck()`, `useCancelTruck()`; query keys `['dispatch', companyId, state, q]`, `['truck', id]`; every truck mutation calls `afterTruckChange(qc, identity, truck)` = set `['truck', id]`, invalidate dispatch, home, orders and that order.
  - `AssignVehicleScreen({ subOrderId, truckId? })`: canvas 07 (assign) / 34 (edit): plant banner ("Loads at Aarav · Siltara. The plant supervisor gets this truck as a weighing task."), vehicle number (auto upper-case, Recent chips that also fill transporter and driver), transporter picker (transporter parties + "Self"), driver name/phone, LR (optional), load plan with a checkbox per line, "N MT pending" caption and planned qty prefilled with assignable; over-assignable shows an amber warning, never blocks; "Assign · notify plant"; server `warnings` shown as a toast after success. Edit mode hides the plan once tare exists, and "Cancel truck" opens `CancelTruckSheet` (reason chips + note).
  - `DispatchScreen`: canvas 08: unit switcher, segmented filter (Open · Loading · At gate · Assigned · Dispatched today), counts, search, `TruckCard`s; plant head read-only (no assign / cancel / weigh actions, no money).
  - `TruckDetailScreen`: canvas 09: vehicle, transporter, driver (call), order link, progress (Assigned → Tare → Gross → Dispatched; **no "Gross weighed" step**), plan vs allocation per line, weighments timeline (superseded struck through, clock-skew flag), slip number, actions by role (Edit vehicle / LR, Cancel, Capture tare/gross for owner, Correct weight → Task 10).

- [ ] **Step 1: Failing tests** (`dispatch.test.tsx`, mock API): Rajesh assigns CG 04 MK 2291 from order 0142-A → detail shows "Assigned", order detail shows "1 assigned"; Recent chip fills driver and transporter; broker-only order → inline "Add a customer to this order before assigning a vehicle"; cancel with a reason → board no longer lists it under Open; Kiran (plant head) sees the board without Assign/Cancel buttons and no ₹ text anywhere; KRM unit filter shows only KRM trucks; Home shows "In plant now" with the loading truck.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; lint + typecheck.
- [ ] **Step 5: Commit** `feat(mobile): assign and edit vehicle, dispatch board and truck detail, in-plant trucks`

---

### Task 10: Needs attention and correct weight (owner)

**Files:**
- Create: `apps/mobile/src/api/hooks/rejections.ts`, `apps/mobile/src/screens/attention/{NeedsAttentionScreen,RejectionDetailSheet}.tsx`, `apps/mobile/src/screens/dispatch/CorrectWeightSheet.tsx`, `apps/mobile/app/(app)/attention.tsx`, `apps/mobile/test/attention.test.tsx`
- Modify: `src/screens/MoreScreen.tsx` (row with open-count badge, owner only), `src/nav/` route guard (owner only), `TruckDetailScreen` (Correct weight action)

**Interfaces:**
- Consumes: Task 6 routes; `Keypad` (Task 8); `checkAllocations`, `splitProRata` (Task 1).
- Produces:
  - `NeedsAttentionScreen`: list of open rejections (vehicle, plant, who, when, what was sent in the user's basis, why, in plain words from `messageFor`), segmented Open · All; detail sheet with **Restore** (explains what will happen: "Puts CG 04 MK 2291 back to loading and dispatches it with these weights") and **Dismiss** (reason ≥ 3 characters). Empty state "Nothing needs attention".
  - `CorrectWeightSheet`: tare and gross keypads, live net, split when > 1 line, reason; shows the old and new net and "Broker earning is recalculated with the rates at dispatch" (owner only sees ₹ difference).

- [ ] **Step 1: Failing tests** (mock API): after a rejected sync (built via `mock.controls` + API calls), Rajesh sees "Needs attention · 2" on More; Restore → list empty, truck detail shows Dispatched; Dismiss without a reason is disabled; Priya (city staff) has no More row and `/attention` redirects; Correct weight 24.180 → 22.000 shows net −2.180 and saves.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; lint + typecheck.
- [ ] **Step 5: Commit** `feat(mobile): needs attention (restore, dismiss) and owner weight correction`

---

### Task 11: Docs, full verification, device walkthrough

**Files:**
- Modify: `CLAUDE.md` (F3 done; offline layout `src/offline/`; device store per user; sync triggers; Demo Offline vs outbox; new demo trucks), `.superpowers/sdd/<run>/progress.md`

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test`: all green.
- [ ] **Step 2: Emulator walkthrough** (`npx expo start --localhost`, `adb reverse tcp:8081 tcp:8081`):
  - Rajesh assigns a truck.
  - Switch to Ravi, turn on Offline, then capture tare and gross; the banner shows 2 saved.
  - Turn Offline off; it syncs and the slip number appears. On the SQLite device store, kill the app before the sync and confirm the weights survive the restart.
  - As Rajesh, the order shows the dispatched quantity.
  - Run the cancelled-truck rejection: restore it from Needs attention.
  - As Kiran, the board shows no ₹.
  - Repeat in kg basis and in dark theme.
- [ ] **Step 3: Commit** `docs: CLAUDE.md for F3`
