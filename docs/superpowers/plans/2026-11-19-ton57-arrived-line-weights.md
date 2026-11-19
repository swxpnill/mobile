# TON-57 — Vehicle Arrived, Per-Product Weights, Auto-Dispatch, Contact Supervisor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervisors mark a truck "Arrived" before tare, then weigh each product line (gross is calculated, never typed), and saving the weights dispatches the truck; the office can call or WhatsApp the plant's supervisor from Dispatch detail.

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
9. **City staff may correct weights after dispatch** (`weighment.correctAfterDispatch` gains `city_staff`). The correction sheet keeps its current inputs (gross and split). Per-line correction is out of scope.
10. **Dispatch notifies owner and all city staff** (card §3), plus the plant heads of that plant (F5 rule kept). The order's creator rule becomes redundant for dispatch and is dropped there; it stays for over-tolerance and short close.
11. **Assigned supervisor card:** the active supervisors of the truck's plant, each with name, plant and phone, and two actions: **Call** (`tel:+91…`) and **WhatsApp** (`https://wa.me/91XXXXXXXXXX?text=…`, text = "`{vehicleNo}` · `{subOrderNumber}` · `{stage}`"). Shown to owner, city staff and plant heads (the roles that already see Dispatch detail); never to supervisors. With no active supervisor at the plant: "No supervisor at {plant} yet".

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
- [ ] **Step 5:** Commit `feat(shared,mock-api): vehicle arrival before tare; sub-order lines on tasks`.

### Task 2: Policy and notifications: city staff corrections, dispatch tells owner and city staff

**Files:**
- Modify: `packages/shared/src/policy.ts` (`city_staff` += `weighment.correctAfterDispatch`), `packages/shared/src/notifications/recipients.ts` (`truck.dispatched`: owner, every city staff, plant heads at the plant)
- Test: `packages/shared/src/notifications/notifications.test.ts`, `packages/shared/src/policy.test.ts`, `packages/contract-tests/src/suites/trucks.contract.ts` (correct-weight)

- [ ] **Step 1: Failing tests:** `can('city_staff', 'weighment.correctAfterDispatch')` is true and stays false for plant roles; `recipientsFor({ kind: 'truck.dispatched', actorId: 'ravi', plantIds: ['siltara'] })` → owner, priya, amit, kiran; contract: Priya's `POST /v1/trucks/:id/correct-weight` → 200 (it was 403), Kiran's → 403.
- [ ] **Step 2:** Run the three suites. Expected: FAIL.
- [ ] **Step 3:** Implement. In the app, `TruckDetailScreen` already gates "Correct weight" with `can(role, 'weighment.correctAfterDispatch')`; check that, and update its test that expects city staff not to see the button.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shared): city staff correct weights; dispatch notifies owner and city staff`.

### Task 3: "Arrived" across the app, and the Vehicle arrived button

**Files:**
- Modify: `apps/mobile/src/screens/dispatch/truckStateMeta.tsx` (`at_gate` label `Arrived`; `TRUCK_STEPS = ['Assigned', 'Arrived', 'Tare weighed', 'Loading', 'Dispatched']` and a `stepIndex(state)` for the 5-segment bar), `TruckTimeline.tsx`, `TruckCard.tsx`, Home "In plant now" badge, `apps/mobile/src/screens/supervisor/TasksScreen.tsx` (badge `Arrived`; button "Vehicle arrived" replaces "At gate"; "Capture tare weight" disabled until arrived, with the caption "Mark the vehicle arrived first")
- Test: `apps/mobile/test/supervisor.test.tsx`, `apps/mobile/test/dispatch.test.tsx`

**Interfaces:**
- Produces: `stepIndex(state: TruckState): 0..4` (assigned 0, at_gate 1, loading 3 — Tare weighed done, Loading current — dispatched 4).

- [ ] **Step 1: Failing tests:** an assigned task shows "Vehicle arrived" and a disabled "Capture tare weight" (`accessibilityState.disabled`); pressing "Vehicle arrived" saves an `AT_GATE` row and the badge reads "Arrived"; then tare is enabled. Dispatch board and truck detail show "Arrived" for `at_gate`, and detail's timeline lists Assigned, Arrived, Tare weighed, Loading, Dispatched.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/supervisor.test.tsx test/dispatch.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement; update the existing tests' "At gate" expectations.
- [ ] **Step 4:** Run again plus `test/a11y.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): Vehicle arrived step before tare`.

### Task 4: Weigh each product; gross is calculated; Save weights dispatches

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
[ Save weights · mark dispatched ]
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
