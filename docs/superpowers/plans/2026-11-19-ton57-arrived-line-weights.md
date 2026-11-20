# TON-57 — Vehicle Arrived, Per-Product Weights, Auto-Dispatch, Contact Supervisor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervisors mark a truck "Arrived" before tare, then weigh each product line (gross is calculated, never typed); saving the weights sends the truck to the office, where the owner or city staff approve it for dispatch (and may change its weights first); the office can call or WhatsApp the plant's supervisor from Dispatch detail.

> **Revised 2026-11-20 (client):** the office approves every dispatch. Saving the weights no longer dispatches; it puts the truck in a new state `weighed` ("Awaiting approval"). Owner and city staff approve it (that is the dispatch) and may change its weights before and after approval. See Rulings 9, 10 and 12–20 and the rewritten Task 2. Where an older line below says "saving dispatches", read "saving sends for approval".

**Architecture:** This reshapes the F3 capture flow without changing how weights are stored or synced. "Arrived" is the existing `AT_GATE` event and `at_gate` state, renamed and now required before `TARE`. Line weights are already stored per line as allocations on the `GROSS` event (Σ allocations = gross − tare). The phone now asks for the per-line nets and computes `grossKg = tare + Σ nets`. `GROSS` already dispatches in one transaction. Server changes are small and contract-first: refuse a tare before arrival, put the sub-order's lines on the task, widen weight correction to city staff, change who is told about a dispatch, and put the plant's supervisors on the truck.

**Tech Stack:** as F5 (Expo Go, Expo Router, TanStack Query, zod in `packages/shared`, mock API, contract suite, jest + RNTL 14).

**Spec:** Notion task TON-57 (https://app.notion.com/p/41c2c11ff0af815caa93f0e50ab5808c), plus `docs/superpowers/specs/2026-11-04-tonnage-design.md` §5.1 (tolerance close), §5.2 (truck state machine), §6 (sync events), §7.1. Note: the design canvas has **not** been updated for TON-57 (Weighment still shows the gross keypad, Dispatch detail has no supervisor card). New screens follow the card's wording and the existing boards' look (09 Dispatch detail, 11 Queue, 12 Weighment, 36 Tare).

**Builds on:** `feat/f5` (notifications, recipients, dark tokens, a11y audit).

## Rulings (calls made without the client; each is reversible)

1. **In-app message thread: deferred.** Card §4's per-truck thread with push is a feature of its own (model, routes, two screens, a notification kind). This plan builds Call (`tel:`) and WhatsApp (`wa.me`). A new Notion card "In-app messages per truck" is filed in Task 6.
2. **No Supabase.** The changes go into shared schemas, the mock and the contract suite now, and into the B2/B3 Postgres migrations later (spec §12). Quantities stay integer kg; MT is display and input only.
3. **"Arrived" = `at_gate` renamed.** State names and sync event types stay (`at_gate`, `AT_GATE`). This keeps phone outboxes and the contract stable. Labels change everywhere to **Arrived**.
4. **Tare requires arrival.** Server: a `TARE` on an `assigned` truck is refused with a new sync code `ARRIVAL_REQUIRED` (it goes to Needs attention like other refusals). Phone: the "Capture tare weight" button is disabled until "Vehicle arrived" is saved. The phone always queues `AT_GATE` before `TARE`, so an offline sequence syncs in order.
5. **Stages shown:** Assigned → Arrived → Tare weighed → Loading → Dispatched. The truck state machine is unchanged: `loading` covers "Tare weighed" (the step done) and "Loading" (the current step). Progress bars have 5 segments.
6. **Per-product entry:** after tare, one weight per line of the truck's plan, showing planned and the difference ("+0.180 over · allowed", "−0.500 under · allowed", "Exact"). Gross = tare + Σ line weights, live and read-only. **Save weights** is enabled when every listed line has a weight (0 allowed on a line; the total must be > 0). It saves one `GROSS` event: `grossKg = tare + Σ`, `allocations = [{ orderLineId, netKg }]` with 0-kg lines left out.
7. **Add a line:** "Add product" lists the sub-order's other lines (same order, same company; a truck loads at one plant). A line from another sub-order is not offered. The server already accepts allocations to any line of the truck's sub-order.
8. **No tolerance check on the truck:** the phone's plausibility question (under 50 % / over 150 % of plan) is removed; over and under show as information only. The **sub-order** completion tolerance (spec §5.1, client answer #23: closes within 1,000 kg) is a business rule, not a check, and stays.
9. **Owner and city staff change weights, before and after approval** (revised). The action `weighment.correctAfterDispatch` is renamed `weighment.correct` and granted to `city_staff`. `POST /v1/trucks/:id/correct-weight` accepts a truck that is `weighed` or `dispatched`. The correction sheet keeps its current inputs (tare, gross and split); per-line entry in the sheet is out of scope.
10. **Who is told** (revised). Saving weights tells the approvers: new kind `truck.weighed` → owner and every city staff (alert). Approval is the dispatch: `truck.dispatched` → owner, every city staff, plant heads of that plant (alert) and that plant's supervisors (row and silent sync, so Done today updates). Never the actor. The order-creator rule is dropped for dispatch; it stays for over-tolerance and short close.
11. **Assigned supervisor card:** the active supervisors of the truck's plant, each with name, plant and phone, and two actions: **Call** (`tel:+91…`) and **WhatsApp** (`https://wa.me/91XXXXXXXXXX?text=…`, text = "`{vehicleNo}` · `{subOrderNumber}` · `{stage}`"). Shown to owner, city staff and plant heads (the roles that already see Dispatch detail); never to supervisors. With no active supervisor at the plant: "No supervisor at {plant} yet".
12. **New truck state `weighed`, label "Awaiting approval".** `loading --GROSS--> weighed --approve--> dispatched`. Weights (gross, allocations) are stored at GROSS with `weighedAt` (business time); nothing about money or the order's closing happens yet.
13. **`weighed` is an open truck.** It counts for vehicle busy, keeps the sub-order from closing within tolerance and blocks what open trucks block. Its kg are **not dispatched**: pending, Home's dispatched today, reports, broker dues and the party's lifted totals see it only after approval.
14. **Approve = dispatch.** `POST /v1/trucks/:id/approve` `{ version }`, action `dispatch.approve` (owner, city staff; plant roles 403), idempotent (`Idempotency-Key` required) and transactional. Only from `weighed` (409 `NOT_AWAITING_APPROVAL` otherwise; a replay of the same key returns the first answer). In one transaction: state `dispatched`, `dispatchedAt` = approval time, the loading slip numbered at approval time, the broker earning (dated by `dispatchedAt`), `truck.dispatched` notifications, then the tolerance close. Response: the truck.
15. **Changing weights while `weighed`** replaces tare, gross and allocations (old weighments kept as superseded), needs a reason (3–200), writes activity `truck.weight_corrected`, and touches no ledger row or tolerance close (there are none yet). After approval it behaves as today (earning rewritten from the snapshot rates, tolerance re-evaluated).
16. **Not approving.** A `weighed` truck can be cancelled (the existing cancel, any reason). Its driver, vehicle and LR fields stay editable; its plan is locked (`TRUCK_LOCKED`).
17. **Sync on a `weighed` truck:** `AT_GATE` is an accepted no-op (as on dispatched); `TARE` and a new `GROSS` are refused `ALREADY_WEIGHED` (Needs attention, like other refusals; the office corrects weights instead). A replay of the accepted GROSS's event id is `duplicate`.
18. **The phone:** a `weighed` truck leaves My tasks (the supervisor's work is done) and shows in Done today as "Awaiting approval" with no loading slip; it shows "Dispatched" with its slip once approved. `GET /v1/supervisor/done-today` lists trucks weighed today (IST) by `weighedAt`, each with `status: 'awaiting_approval' | 'dispatched'`, `loadingSlipNo` and `dispatchedAt` null until approved.
19. **The office:** the Dispatch board gets a count and filter **To approve** (`weighed`), listed first in Open; a `weighed` card shows "Awaiting approval" and, for owner and city staff, **Approve dispatch**; never "Dispatched" before approval. Truck detail shows the weights, **Change weights** and **Approve dispatch**. Plant heads see the state, without the actions.
20. **Demo data:** one Siltara truck seeded `weighed` so To approve is populated after Reset demo data.

## Global Constraints

- Integer kg in storage and arithmetic; format and parse only with `packages/shared/src/units.ts` (`toDisplayQty`, `parseQtyInput`). MT shows 3 decimals.
- Sync event types stay `AT_GATE | TARE | GROSS`; `GROSS` keeps `{ grossKg, allocations }` and its Σ invariant (spec §4 `truck_line_allocations`).
- A behaviour change starts with a contract test. Out-of-scope = 404.
- Colours from tokens only (lint enforced); new screens pass `auditA11y` and the dark-theme colour test.
- Expo Go only; `Linking.openURL` for `tel:` and `wa.me`.
- Conventional commits; tests first; `await` RNTL events.

## Review Focus

1. **A phone with an offline `TARE` queued and no `AT_GATE` before it** (built before this change) → refused `ARRIVAL_REQUIRED`, shows in Needs attention, and Restore applies arrival and then the tare. Test in Task 1.
2. **Partial load:** a 24.000 MT plan line weighed at 10.000 → truck dispatched, line pending 14.000, sub-order Partly dispatched (no tolerance close). Test in Task 1 (contract) and Task 4 (screen).
3. **A line weight left blank** → Save weights disabled with "Enter a weight for every product"; **all lines 0** → disabled with "Enter at least one weight". Test in Task 4.
4. **Supervisor phone missing or not a mobile** → the card shows the name with no Call/WhatsApp buttons rather than a broken link. Test in Task 5.
5. **Unit basis kg** → line inputs and gross in whole kg ("24,180 kg"), saved values identical to the MT entry of the same weight. Test in Task 4.

---

### Task 1: Shared and mock rules: arrival before tare, sub-order lines on the task (contract first)

**Files:**
- Modify: `packages/shared/src/schemas/trucks.ts` (`SYNC_REJECT_CODES` + `ARRIVAL_REQUIRED`; `taskSchema.lines`), `packages/shared/src/notifications/render.ts` (`SYNC_REJECT_REASON.ARRIVAL_REQUIRED`), `packages/shared/src/rules/trucks.ts` (`grossFromLines`, `lineDiff`)
- Modify: `packages/mock-api/src/dispatch.ts` (TARE from `assigned` → reject), `packages/mock-api/src/truck-views.ts` or the task builder (`lines`), rejection restore path (restoring an `ARRIVAL_REQUIRED` TARE applies arrival first)
- Test: `packages/contract-tests/src/suites/sync.contract.ts`, `packages/shared/src/rules/trucks.test.ts`

**Interfaces:**
- Produces: `ARRIVAL_REQUIRED` in `SyncRejectCode`, reason text "The tare arrived before the truck was marked arrived".
- `taskSchema.lines: z.array(z.object({ orderLineId, productName, length: lengthSchema.nullable(), pendingKg: int })).default([])` — every line of the truck's sub-order (default `[]` so tasks already stored on phones still parse).
- `grossFromLines(tareKg: number, lineNetKg: readonly number[]): number` = tare + Σ; `lineDiff(netKg: number, plannedKg: number): { kind: 'over' | 'under' | 'exact'; kg: number }` (kg ≥ 0).

- [ ] **Step 1: Failing tests:**
  - `rules/trucks.test.ts`: `grossFromLines(12_460, [24_000, 180]) === 36_640`; `lineDiff(24_180, 24_000)` → `{ kind: 'over', kg: 180 }`; `lineDiff(23_500, 24_000)` → `{ kind: 'under', kg: 500 }`; equal → `exact`.
  - `sync.contract.ts`: TARE on an `assigned` truck → `rejected` `ARRIVAL_REQUIRED`, truck still `assigned`; AT_GATE then TARE in one batch → both accepted, state `loading`.
  - Review Focus 1: the refused TARE appears in `GET /v1/weighment-rejections`; `restore` → truck `loading` with that tare and an `atGateAt` set.
  - Task lines: `GET /v1/supervisor/tasks` items carry `lines` for every line of the sub-order, with `pendingKg`.
  - Review Focus 2: assign 24,000 kg on line A, AT_GATE, TARE 12,000, GROSS 22,000 with `[{A, 10_000}]` → accepted, truck `dispatched`, line A `pendingKg` 14,000, sub-order `partly_dispatched`.
  - GROSS with an allocation to a sub-order line not in the plan → accepted (Ruling 7).
- [ ] **Step 2:** Run `pnpm --filter @tonnage/contract-tests exec vitest run -t "sync"` and `pnpm --filter @tonnage/shared exec vitest run src/rules/trucks.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update any existing contract test that sends TARE straight from `assigned` to send AT_GATE first (these tests assumed the old optional arrival).
- [ ] **Step 4:** Run `pnpm test` at the root. Expected: PASS (app tests that weigh from `assigned` are updated the same way).
  Built: `task.lines` is `{ orderLineId, productName, pendingKg }` (the task's `productName` already includes the length, so no separate `length`). The owner weighing a tare on a truck still `assigned` (Dispatch detail) records `AT_GATE` then `TARE` on the phone, same instant. Restore marks the arrival at the tare's business time (`markArrived`, activity `truck.at_gate` with `restored: true`). Contract tests that weigh call `arrive(t, …truckIds)` first (the owner from a dedicated arrival device), and cancel with the post-arrival version. `truckToTask` sends `lines: []`; Task 4 fills them for the owner path.
- [ ] **Step 5:** Commit `feat(shared,mock-api): vehicle arrival before tare; sub-order lines on tasks`.

### Task 2 (revised 2026-11-20): Office approves dispatch; owner and city staff change weights

Rulings 9, 10 and 12–20. Two commits: 2a server (shared, mock, contract), 2b app.

**Files (2a):**
- Modify: `packages/shared/src/schemas/orders.ts` (`truckStateSchema` + `weighed`), `schemas/trucks.ts` (`truckSchema.weighedAt`, `DISPATCH_STATES` + `weighed`, board `counts.weighed`, `doneTodaySchema` items `status`/`weighedAt`, nullable `loadingSlipNo`/`dispatchedAt`, `approveTruckBodySchema`, `SYNC_REJECT_CODES` + `ALREADY_WEIGHED`), `rules/trucks.ts` (`nextTruckState`: gross → `weighed`, new event `approve`), `policy.ts` (`weighment.correct`, `dispatch.approve`), `errors.ts` (`NOT_AWAITING_APPROVAL`), `notifications/` (kind `truck.weighed`, recipients, copy, deep link)
- Modify: `packages/mock-api/src/dispatch.ts` (GROSS → weighed; `approveDispatch` holds what GROSS did), `handlers/trucks.ts` (approve route; correct-weight on weighed; edit lock; board), `orders-math.ts` (`weighed` open), `handlers/supervisor.ts` (done today), `truck-views.ts`, `seed-orders.ts`, `trucks.ts` (fixture builder), `notifications.ts`, `store.ts` (`weighedAt`)
- Test: `packages/shared/src/rules/trucks.test.ts`, `policy.test.ts`, `notifications/notifications.test.ts`; `packages/contract-tests/src/suites/sync.contract.ts`, `trucks.contract.ts`, `notifications.contract.ts`, plus every suite that dispatched by GROSS alone (they now approve)

- [ ] **Step 1: Failing tests (2a):**
  - Rules: `nextTruckState('loading','gross') === 'weighed'`; `nextTruckState('weighed','approve') === 'dispatched'`; `nextTruckState('weighed','cancel') === 'cancelled'`; tare/gross/at_gate on `weighed` → null.
  - Policy: `dispatch.approve` and `weighment.correct` for owner and city staff only.
  - Recipients: `truck.weighed` by Ravi at Siltara → owner, Priya, Amit; `truck.dispatched` by Priya at Siltara → owner, Amit, Kiran (alert), Ravi (row-and-sync).
  - Contract, sync: AT_GATE, TARE, GROSS → truck `weighed`, `weighedAt` set, `loadingSlipNo` null, no ledger row, sub-order pending unchanged; result has no `loadingSlipNo`; task gone from `GET /v1/supervisor/tasks` (`removed`). A second GROSS (new event id) → `ALREADY_WEIGHED`; TARE → `ALREADY_WEIGHED`; AT_GATE → accepted no-op.
  - Contract, approve: Priya approves → 200, `dispatched`, slip issued, `dispatchedAt` = approval time, earning row; tolerance close happens here (not at GROSS); replay with the same key → same body; approve again with a new key → 409 `NOT_AWAITING_APPROVAL`; stale version → 409 `STALE`; no key → 400; Kiran → 403; Ravi → 403; out-of-scope truck → 404.
  - Contract, change weights while weighed: Priya → 200, weights replaced (old superseded), still `weighed`, no ledger rows; after approval → earning rewritten as before. A `loading` truck → 409 `TRUCK_LOCKED`.
  - Contract, cancel a weighed truck → `cancelled`; edit its plan → 409 `TRUCK_LOCKED`, its driver → 200.
  - Contract, board: `counts.weighed`, filter `weighed`, Open lists weighed first; Home's dispatched today and the dispatch register exclude a weighed truck until approval.
  - Contract, done today: Ravi's done today lists the weighed truck `awaiting_approval` (slip null), then `dispatched` with its slip after approval.
- [ ] **Step 2:** Run the shared tests and the contract suite. Expected: FAIL.
- [ ] **Step 3:** Implement. Move GROSS's dispatch work (slip, earning, notify, tolerance) into `approveDispatch(state, ctx, truck)`; GROSS stores weights and notifies `truck.weighed`. Existing suites that expected GROSS to dispatch call a shared `approve(t, truckId)` helper.
- [ ] **Step 4:** `pnpm test`. Expected: PASS (the app's tests that assumed GROSS dispatches are updated in 2b; until then 2a keeps `pnpm --filter mobile` compiling with the new state in every `Record<TruckState, …>`).
- [ ] **Step 5:** Commit `feat(shared,mock-api): office approves dispatch; owner and city staff change weights`.

**2b (app):** `truckStateMeta` (`weighed`: "Awaiting approval"), Dispatch board chip **To approve**, `TruckCard` and `TruckDetailScreen` (**Approve dispatch**, **Change weights** for `may('weighment.correct')` on `weighed | dispatched`), `useApproveTruck` hook, supervisor Done today and the Dispatched screen read `status`, Home "In plant now". Tests first in `test/dispatch.test.tsx`, `test/supervisor.test.tsx`; a11y and dark-theme suites stay green. Commit `feat(mobile): approve dispatch; change weights before approval`.


### Task 3 (revised 2026-11-20): "Arrived" across the app, and the Vehicle arrived button

The server already refuses a tare before arrival (Task 1). This task makes the phone ask for the arrival explicitly and renames the step everywhere. No server change.

**Design**
- **One source for steps.** `truckStateMeta.tsx` owns the five progress steps, now that approval exists: `TRUCK_STEPS = ['Assigned', 'Arrived', 'Tare weighed', 'Weighed', 'Dispatched']` and a pure `stepIndex(x: { state, tareKg, atGateAt })`: assigned 1, at_gate 2, loading 3, weighed 4, dispatched 5; a cancelled truck shows how far it got (tare 3, arrived 2, else 1). The board card and the detail timeline both use it (the timeline's own `stepOf` goes).
- **Labels.** `at_gate` reads **Arrived** on every screen: state badge, board filter chip, timeline row, order trucks summary, short close ("arrived"), Needs attention ("Marked arrived", "marks it arrived"). Sync event names stay `AT_GATE` (Ruling 3).
- **My tasks card (assigned truck):** **Vehicle arrived** (violet, primary) first; **Capture tare weight** below it, disabled, with the caption "Mark the vehicle arrived first". After the press (saved on this phone, offline too) the badge reads **Arrived** and the tare button is enabled; nothing else changes. Arrived and loading cards are unchanged apart from the badge.
- **One arrival action.** `useMarkArrived()` (`src/screens/supervisor/useMarkArrived.ts`): records one `AT_GATE` in the outbox, single flight (a double tap records once), toast "Saved on this phone" or the save-failed message. Used by the card and the weigh screen.
- **Weigh screen guard.** A supervisor who reaches `/weigh/:id` on a truck still assigned (an old link, a notification) sees "Mark the vehicle arrived first" with **Vehicle arrived**; once pressed, the tare keypad appears. The owner's weigh path keeps recording the arrival with the tare (Task 1), since the owner is not at the gate.
- **Capture steps** read Assigned ✓ · Arrived ✓ · Tare · Gross · Approval.

**Tests first** (`test/supervisor.test.tsx`, `test/dispatch.test.tsx`, a unit test for `stepIndex`):
- Assigned card: "Vehicle arrived" enabled, "Capture tare weight" disabled (`accessibilityState.disabled`) with the caption; pressing it saves one `AT_GATE` row, the badge reads Arrived and tare is enabled; a double press records one row.
- Offline: arrival then tare queue in order (AT_GATE before TARE) and both are accepted on sync.
- `/weigh` on an assigned truck shows the gate; after Vehicle arrived the tare keypad shows.
- Board chip "Arrived", detail timeline row "Arrived", progress "Step 2 of 5 · Arrived"; no "At gate" text anywhere (a render search over the board, detail and tasks).
- `stepIndex` for every state, cancelled after tare and after arrival.

Commit `feat(mobile): Vehicle arrived step before tare`.

### Task 4: Weigh each product; gross is calculated; Save weights sends for approval

**Files:**
- Create: `apps/mobile/src/screens/supervisor/LineWeightsStep.tsx`
- Modify: `apps/mobile/src/screens/supervisor/CaptureScreen.tsx` (gross mode renders `LineWeightsStep` instead of the gross keypad + `SplitStep`; remove the plausibility question), `OwnerWeighScreen.tsx` (same step), delete `SplitStep.tsx` if nothing else uses it
- Test: `apps/mobile/test/supervisor.test.tsx`

**Interfaces:**
- Consumes: `grossFromLines`, `lineDiff` (Task 1), `task.lines` (Task 1), `parseQtyInput`, `toDisplayQty`, `recordCapture`.
- Produces: `LineWeightsStep({ task, basis, onSave(input: { grossKg: number; allocations: { orderLineId: string; netKg: number }[] }): Promise<void> })`.

Screen (board 12 look, header "Weigh products", subtitle "`{vehicleNo}` · `{subOrderNumber}`"; steps strip Assigned ✓ · Arrived ✓ · Tare ✓ · **Weigh** · Dispatch):
```
Tare · weighed 10:12                 12.460
┌ TMT Fe500D · 12 mm · 12 m ─────────────┐
│ Planned 24.000 MT        [ 24.180 ]    │  ← tap a row to type into it with the keypad
│ +0.180 over · allowed                  │
└────────────────────────────────────────┘
+ Add product
Gross (calculated)                   36.640 t     ← read-only, aria-live polite
[ Save weights · send for approval ]
[ keypad ]
```

- [ ] **Step 1: Failing tests:**
  - Typing 24.18 on the only line → gross reads "36.640" (tare 12.460) and the diff "+0.180 over · allowed"; Save weights → one `GROSS` outbox row with `grossKg: 36_640` and `allocations: [{ orderLineId, netKg: 24_180 }]`; the screen goes to Dispatched (the existing route).
  - Two plan lines, one left blank → Save disabled, caption "Enter a weight for every product"; both 0 → "Enter at least one weight" (Review Focus 3).
  - "Add product" lists `task.lines` not already shown; adding one adds an empty row.
  - A net of 30 % of plan saves without any question (the plausibility sheet is gone).
  - kg basis: typing 24180 shows "24,180 kg" and saves the same `netKg` as typing 24.18 in MT (Review Focus 5).
  - `auditA11y` clean on the screen.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/supervisor.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. One focused row at a time drives the existing `Keypad`. The `WeightReadout` live region moves to the gross line.
- [ ] **Step 4:** Run the supervisor and dispatch suites, then `pnpm --filter mobile test`. Expected: PASS.
- [ ] **Step 5:** Emulator: as Ravi, Vehicle arrived → tare → two lines → Save weights; owner's Dispatch board shows it dispatched; screenshot both themes.
- [ ] **Step 6:** Commit `feat(mobile): weigh each product; gross calculated; saving dispatches`.

### Task 5: Dispatch detail: Assigned supervisor card with Call and WhatsApp

**Files:**
- Modify: `packages/shared/src/schemas/trucks.ts` (`truckSchema.supervisors: { id, name, mobile }[]`), mock truck view (active supervisors of `truck.plantId`), `packages/contract-tests/src/suites/trucks.contract.ts`
- Create: `apps/mobile/src/screens/dispatch/SupervisorCard.tsx`, `apps/mobile/src/format/contactLinks.ts`
- Modify: `apps/mobile/src/screens/dispatch/TruckDetailScreen.tsx`
- Test: `apps/mobile/test/dispatch.test.tsx`, `apps/mobile/test/contact-links.test.ts`

**Interfaces:**
- `telLink(mobile: string): string | null` (`+919826100014` → `tel:+919826100014`; anything not a normalized Indian mobile → null); `whatsappLink(mobile: string, text: string): string | null` → `https://wa.me/919826100014?text=<encodeURIComponent(text)>`.

- [ ] **Step 1: Failing tests:**
  - Contract: `GET /v1/trucks/:id` for a Siltara truck → `supervisors` = `[{ name: 'Ravi Verma', mobile: '+919826100014' }]` (Deepak, invited at Tilda, is not on Siltara trucks); inactive supervisors are left out.
  - `contact-links.test.ts`: the examples above; `telLink('')` and `telLink('12345')` → null (Review Focus 4).
  - Screen: owner on a Siltara truck sees "Assigned supervisor", "Ravi Verma", "Siltara · 98261 00014", buttons "Call Ravi Verma" and "WhatsApp Ravi Verma"; pressing WhatsApp calls `Linking.openURL` with text "CG 04 MK 2291 · SO-2611-0142-A · Loading"; a plant with no supervisor shows "No supervisor at Tilda yet"; a supervisor with an unusable number shows no buttons.
- [ ] **Step 2:** Run the contract and app tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The card sits above "Driver & transporter", in the same row style as the driver row (`cb` icon buttons, phone and message icons).
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS; the dark-theme and a11y suites stay green.
- [ ] **Step 5:** Commit `feat: assigned supervisor card with Call and WhatsApp on Dispatch detail`.

### Task 6: Docs, Notion and final checks

- [ ] **Step 1:** CLAUDE.md: the "Trucks and dispatch" bullet gains the arrival rule (`ARRIVAL_REQUIRED`), per-line entry with calculated gross, no plausibility question, city staff corrections, and dispatch recipients; the supervisor layout line names `LineWeightsStep`.
- [ ] **Step 2:** Notion: set TON-57's Plan to this file's path. Create a To-do card "In-app messages per truck (TON-57 §4)" (Milestone F5, Area Mobile), with Done when "Owner, city staff and plant head can message a truck's supervisor in a thread on Dispatch detail; the supervisor gets a push and replies from the task; contract tests cover thread scope".
- [ ] **Step 3:** `pnpm lint`, `pnpm typecheck`, `pnpm test`. Expected: all pass.
- [ ] **Step 4:** Commit `docs: TON-57 in CLAUDE.md`.
