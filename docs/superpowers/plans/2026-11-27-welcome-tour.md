# Welcome, role tours and first-visit tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canvas boards 41–46 for all four roles: Welcome back on every reopen, a first-sign-in tour intro, spotlight tours over the real screens, one-time first-visit tips, and Help & tour.

**Architecture:** A new `apps/mobile/src/onboarding/` module. Pure content (tours, tips, how-to) is filtered by `policy.ts` and `tabsForRole`. A per-person AsyncStorage store remembers progress. A `TourProvider` mounted in `app/(app)/_layout.tsx` owns one in-tree overlay (not a `Modal`, so the lock screen still covers it) that shows the welcome, tour or tip. `TourTarget` wrappers on real screens report their window rects for the SVG spotlight.

**Tech Stack:** Expo Router, React Native 0.8x, zustand, AsyncStorage, react-native-svg 15.16 (already installed), TanStack Query, jest + RNTL 14.

**Spec:** `docs/superpowers/specs/2026-11-27-welcome-tour-design.md`

## Global Constraints

- Expo Go only; **no new dependencies**.
- Every colour is a token in `src/theme/tokens.ts` (both palettes). Lint refuses literals; `test/dark-theme.test.tsx` and `test/contrast.test.ts` must stay green. New text pairs are added to the contrast test.
- Every new screen and overlay passes `test/a11y/audit.ts` (role, readable, 44 dp, header).
- Visibility comes from `can(role, action)` and `tabsForRole(role)`, never from a role check where an action exists.
- Quantities go through `toDisplayQty` / `unitLabel` (viewer's unit basis); never formatted by hand.
- Reduce motion (`useReduceMotion`): no slides, pulses or spinning; instant changes.
- **Welcome back cannot be dismissed by a tap** (user decision 2026-11-27).
- Copy must not contain "Gross weighed", "save to dispatch" or "Save weights & dispatch".
- RNTL 14: always `await` `fireEvent.*` and `unmount()`; use `advanceTimersByTimeAsync` with fake timers; give test QueryClients `mutations: { gcTime: Infinity }`.
- Commits: Conventional Commits with scope, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Overlay vs a sheet or lock:** a tip or tour step must never appear while a `Sheet` is open or the app is locked. It waits and shows afterwards. *Test in Task 4 and Task 8.*
2. **Person switch mid-tour (Demo tools) or sign-out:** the overlay closes and the next person's state is their own. *Test in Task 4.*
3. **Target moves or disappears** (scroll, large text, a task card removed by sync): the step re-measures on layout. If the target is gone, the card is centred with no hole. *Test in Task 4.*
4. **Storage unreadable or malformed:** the app starts as if nothing has been seen, and never crashes or loops the intro. *Test in Task 1.*
5. **Notification tap that started the app:** the welcome closes at once and the link opens. *Test in Task 6.*

---

## File map

| File | Responsibility |
|---|---|
| `src/onboarding/store.ts` | per-person progress, open-sheet counter, reset |
| `src/onboarding/tours.ts` | tour steps per role + `stepsFor` |
| `src/onboarding/tips.ts` | tip catalogue + `tipsFor` |
| `src/onboarding/howTo.ts` | "How do I…" topics per role |
| `src/onboarding/geometry.ts` | pure `spotlightPath`, `placeCard` |
| `src/onboarding/targets.ts` | target rect registry (zustand) |
| `src/onboarding/TourTarget.tsx` | measures and registers a wrapped view |
| `src/onboarding/TourProvider.tsx` | which overlay shows; tour state; Android Back |
| `src/onboarding/SpotlightOverlay.tsx` | SVG scrim with a hole and a ring |
| `src/onboarding/CoachCard.tsx` | step card |
| `src/onboarding/WelcomeScreen.tsx` | board 41 + `welcomeLine` |
| `src/onboarding/TourIntroSheet.tsx` | board 42 |
| `src/onboarding/TipBubble.tsx`, `useFirstTip.ts` | board 45 |
| `src/screens/help/HelpTourScreen.tsx`, `TeamTourPreview.tsx`, `HowToSheet.tsx` | board 46 |
| `app/(app)/help.tsx` | route |
| `test/onboarding-*.test.ts(x)` | tests per task |

---

### Task 1: Onboarding store

**Files:**
- Create: `apps/mobile/src/onboarding/store.ts`
- Modify: `apps/mobile/src/api/demo.ts` (`resetDemoData`)
- Modify: `apps/mobile/src/ui/Sheet.tsx` (open-sheet counter)
- Test: `apps/mobile/test/onboarding-store.test.ts`

**Interfaces:**
- Produces:
  - `ONBOARDING_KEY = 'tonnage.onboarding'`
  - `interface PersonProgress { introSeen: boolean; tourDone: boolean; tipsOn: boolean; tipsSeen: string[] }`
  - `DEFAULT_PROGRESS: PersonProgress = { introSeen: false, tourDone: false, tipsOn: true, tipsSeen: [] }`
  - `onboardingStore` (zustand) with `byUser: Record<string, PersonProgress>`, `hydrated: boolean`, `openSheets: number`, `hydrate(): Promise<void>`, `update(userId, patch: Partial<PersonProgress>): void`, `markTipSeen(userId, key): void`, `reset(userId?: string): void` (no id = everyone), `sheetOpened(): void`, `sheetClosed(): void`
  - `useProgress(): PersonProgress & { userId?: string }` (signed-in person from `useMe`, defaults until hydrated)
  - `resetOnboardingForTests(): void`

- [ ] **Step 1: Write failing tests**
  - `hydrate keeps valid fields per person and drops malformed ones`: store `{"u1":{"introSeen":true,"tipsSeen":["a",3]},"u2":"x"}` → `byUser.u1` equals `{ ...DEFAULT_PROGRESS, introSeen: true, tipsSeen: ['a'] }`, `u2` absent.
  - `unreadable JSON hydrates to empty and marks hydrated`.
  - `update persists per person`: `update('u1',{tourDone:true})` → AsyncStorage JSON has `u1.tourDone === true` and no `u2`.
  - `an update made before hydration wins over the stored value`.
  - `markTipSeen is idempotent` (twice → one entry).
  - `reset() clears everyone; reset('u1') only u1`.
  - `sheet counter`: rendering `<Sheet visible>` raises `openSheets` to 1; hiding or unmounting it brings it back to 0.
  - `resetDemoData clears onboarding` (spy `onboardingStore.getState().reset` called with no args).
- [ ] **Step 2: Run** `pnpm --filter mobile exec jest test/onboarding-store.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `store.ts` using the same hydrate/sanitize/persist pattern as `src/prefs/unitFilter.ts`, with `void hydrate()` at module load. In `Sheet.tsx`, add `useEffect(() => { if (visible) { sheetOpened(); return sheetClosed; } }, [visible])`. In `resetDemoData`, call `onboardingStore.getState().reset()` before sign-out.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): onboarding progress store per person`

---

### Task 2: Tour, tip and how-to content

**Files:**
- Create: `apps/mobile/src/onboarding/tours.ts`, `tips.ts`, `howTo.ts`
- Test: `apps/mobile/test/onboarding-content.test.ts`

**Interfaces:**
- Produces:
  - `type TargetId = 'home.units' | 'home.pending' | 'home.inPlant' | 'home.bell' | 'tab.home' | 'tab.orders' | 'tab.new' | 'tab.dispatch' | 'tab.more' | 'tab.tasks' | 'tab.done' | 'tab.profile' | 'tasks.counts' | 'tasks.arrived' | 'tasks.tare' | 'tasks.weigh' | 'order.requestVehicle' | 'dispatch.toApprove' | 'truck.supervisors' | 'ledger.recordPayment' | 'reports.firstTile' | 'attention.first' | 'notifications.list' | 'weigh.lines' | 'done.list'`
  - `interface TourStep { id: string; target?: TargetId; tag: string; title: string; body: string; requires?: Action }`
  - `stepsFor(role: Role, firstName: string): TourStep[]`: drops steps whose `requires` fails `can` or whose `tab.*` target is not in `tabsForRole(role)`. `{name}` in copy is replaced with `firstName`.
  - `tourSummary(role): { steps: number; minutes: 1 }` (steps excluding the final one)
  - `INTRO: Record<Role, { lead: string; points: { icon: IconName; tone: Tone; title: string; body: string }[] }>`
  - `interface Tip { key: string; target: TargetId; title: string; body: string; requires?: Action }`, `TIPS: Tip[]`, `tipFor(role, key): Tip | undefined`
  - `interface HowTo { id: string; title: string; steps: string[]; showMe?: Href; requires?: Action }`, `howToFor(role): HowTo[]`
  - `ROLE_TOUR_NAME: Record<Role, string>` = Owner / City staff / Plant head / Supervisor

- [ ] **Step 1: Write failing tests**
  - `owner tour has 8 steps ending in Done`; `city staff 7`; `plant head 6`; `supervisor 7`. Check the tags in order (from the tables below).
  - `plant head tour never targets tab.new` and `supervisor tour only targets tasks.* / tab.tasks|done|profile`.
  - `no copy contains a retired phrase`: for every role, step, intro point, tip and how-to, the text does not match `/gross weighed|save to dispatch|weights & dispatch/i`.
  - `{name} is replaced` (owner last step title is `You're all set, Rajesh`).
  - `tips are policy-filtered`: `tipFor('plant_head','order.requestVehicle')` is undefined and `tipFor('owner', …)` is defined; supervisor gets `weigh.lines` and `done.list` and none of the office tips. `requires` is typed `Action`, so a name missing from `policy.ts` fails typecheck.
  - `howToFor('plant_head')` contains no topic that requires an action the plant head lacks.
- [ ] **Step 2: Run** `pnpm --filter mobile exec jest test/onboarding-content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files with this exact copy.

**Owner** (`requires` in brackets):

| tag | target | title | body |
|---|---|---|---|
| Units | home.units | Switch between your companies | See all units together, or tap to focus on one. Every screen follows this choice. |
| Pending | home.pending | What still has to go out | Booked but not yet dispatched, split by company. The amber tag flags orders waiting too long. |
| Live | home.inPlant | Trucks in your plants now | Every truck that has arrived, is weighed or loading, live from the supervisors. Tap one to see its weights. |
| Create | tab.new [order.create] | New: one tap for everything | Book an order, assign a loading, or add a customer, broker, product or transporter. |
| Orders | tab.orders | Every order in one list | Split across companies. Track dispatched against pending, edit or short close any time. |
| Dispatch | tab.dispatch | The loading board | Trucks by stage. When a supervisor saves the weights, the truck waits in To approve: your approval dispatches it and gives the loading slip number. |
| More | tab.more | Masters, money and help | Customers, brokers, products, broker ledger, reports and Needs attention live here. Replay this tour from Help & tour. |
| Done | – | You're all set, {name} | That's the tour. A small tip appears the first time you open a new screen. |

**City staff**: the same Units, Pending, Create, Orders and Dispatch rows. More becomes "Money and help" / "Broker ledger and payments, reports and masters live here. Replay this tour from Help & tour." Then Done.

**Plant head:**

| tag | target | title | body |
|---|---|---|---|
| Home | home.pending | Your plants at a glance | What is still to go out from your plants. Prices stay with the office. |
| Live | home.inPlant | Trucks in your plants now | Every truck that has arrived, is weighed or loading. Tap one to see where it is. |
| Orders | tab.orders | Orders for your plants | Every order with material from your plants, and how much is pending. |
| Dispatch | tab.dispatch | Follow every truck | Trucks at your plants by stage, from assigned to dispatched. |
| More | tab.more | Help and settings | Theme, text size, units, and Help & tour to replay this. |
| Done | – | You're all set, {name} | A small tip appears the first time you open a new screen. |

**Supervisor:**

| tag | target | title | body |
|---|---|---|---|
| Today | tasks.counts | Your plant at a glance | Trucks waiting for tare, trucks loading, and what you finished today. Only your plant. |
| Step 1 | tasks.arrived | Tap "Vehicle arrived" at the gate | When the truck reaches the plant, mark it arrived first. The office sees it straight away. |
| Step 2 | tasks.tare | Capture tare (empty truck) | Unlocks after arrival. Read the weighbridge and type the empty-truck weight. |
| Step 3 | tasks.weigh | Enter each product's weight | After loading, type the weight of every product on the truck. Gross is added up for you. |
| Step 4 | – | The office approves | After you save, the truck waits for approval. The owner or city staff approve it and it is dispatched. Your part is done. |
| Done | tab.done | See what you finished | Every truck you weighed today. Works offline: it syncs when the network is back. |
| Ready | – | You're all set, {name} | Replay this anytime from Profile → Help & tour. |

**INTRO** lead: `Hi {name}, here's what you can do as {Role}`. Points:
- owner: "Book orders across all your companies" / "One order, split by company"; "Follow every truck, gate to dispatch" / "Weights come in live from your plants"; "Brokers, dues and reports" / "Commission and overprice worked out for you".
- city_staff: same first two points; third "Approve and record payments" / "Approve weighed trucks and keep broker dues right".
- plant_head: "Your plants' orders" / "What is pending from your plants"; "Trucks in your plants" / "Every truck by stage, live"; "No prices" / "You see weights and trucks, the office sees money".
- supervisor: "Your plant's trucks" / "Only the trucks assigned to your plant"; "Arrive, tare, product weights" / "Three steps per truck"; "Works offline" / "Saves on the phone and syncs later".

**TIPS** (key = target): exactly the spec's table. Requires: `truck.assign`, `dispatch.approve`, `dispatch.view`, `broker.pay`, `reports.view`, `rejections.manage`, none, `tasks.view`, `tasks.view`. Title and body come from the spec's "Tip" column, split at ";" into title and body.

**HOW TO** (owner and city staff): Book one order across companies (`order.create`, showMe `/order-form`); Ask a broker or customer for a truck (`truck.assign`); Approve a weighed truck (`dispatch.approve`, showMe `/dispatch`); Short close an order (`order.edit`); Record a broker payment (`broker.pay`, showMe `/brokers`); Fix a wrong weight (`weighment.correct`). Plant head: Find a truck at my plant; See what is pending for my plant; Call a plant's supervisor. Supervisor: Weigh a truck; Add another product to the truck; No network at the plant; A weight was refused. Each has 3–5 imperative steps naming the real button labels in the app (check each label against the screen while writing).

- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): tour, tip and how-to content per role`

---

### Task 3: Geometry, target registry and TourTarget

**Files:**
- Create: `apps/mobile/src/onboarding/geometry.ts`, `targets.ts`, `TourTarget.tsx`
- Test: `apps/mobile/test/onboarding-geometry.test.ts`

**Interfaces:**
- Produces:
  - `interface Rect { x: number; y: number; w: number; h: number }`
  - `spotlightPath(screen: {w:number;h:number}, hole: Rect | null, pad = 6, radius = 16): string` builds an SVG path: the full-screen rect plus a rounded hole (even-odd), or the full rect only when `hole` is null.
  - `placeCard(screen, hole: Rect | null, cardH: number, margin = 16): { top: number }`: below the hole if `hole.y+hole.h+pad+margin+cardH <= screen.h - margin`, else above if it fits, else centred.
  - `targetsStore` (zustand): `rects: Partial<Record<TargetId, Rect>>`, `set(id, rect)`, `clear(id)`.
  - `<TourTarget id={TargetId} style?>{children}</TourTarget>`: a `View collapsable={false}` that calls `measureInWindow` on layout and when `useTourTick()` (from Task 4; until then a no-op export in `targets.ts`) changes, and clears itself on unmount. A zero-size rect counts as absent.

- [ ] **Step 1: Write failing tests**
  - `path with no hole is the screen rect only` (contains no second `M`).
  - `path with a hole has two subpaths` and the hole starts at `x - pad`.
  - `placeCard below / above / centred`, using screen `{w:412,h:915}`, card 220: hole at y 20 → below; hole at y 840 → above; hole of height 800 → centred (`top = (915-220)/2`).
  - `TourTarget registers and clears`: render with mocked `measureInWindow` callback `(10,20,100,40)` → `rects['home.units']` equals `{x:10,y:20,w:100,h:40}`; unmount → undefined.
- [ ] **Step 2: Run** `pnpm --filter mobile exec jest test/onboarding-geometry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): spotlight geometry and tour targets`

---

### Task 4: Tour engine, overlay and coach card

**Files:**
- Create: `apps/mobile/src/onboarding/TourProvider.tsx`, `SpotlightOverlay.tsx`, `CoachCard.tsx`
- Modify: `apps/mobile/app/(app)/_layout.tsx` (wrap the Stack in `<TourProvider>`)
- Modify: `apps/mobile/src/theme/tokens.ts` (+ `spotRing`, `tipBg`, `tipTx`, `tipTx2` in both palettes; `spotRing` light `rgba(255,255,255,.95)`, dark the same; tip light `#111318` / `#F4F3EF`, dark inverted, as on board 45)
- Modify: `apps/mobile/test/contrast.test.ts` (tipTx on tipBg, tipTx2 on tipBg)
- Test: `apps/mobile/test/onboarding-tour.test.tsx`

**Interfaces:**
- Consumes: `stepsFor`, `targetsStore`, `placeCard`, `spotlightPath`, `onboardingStore`.
- Produces:
  - `useTour(): { active: boolean; startTour(): void; startPreview(role: Role): void; stop(): void }`
  - `useTourTick(): number` (bumps on every step change and window resize; `TourTarget` re-measures on it)
  - `type Overlay = 'none' | 'welcome' | 'intro' | 'tour' | 'tip'` and `useOverlay(): Overlay` (tips and welcome use it in Tasks 6–8)
  - `startTour` sets `introSeen`, navigates `router.navigate('/' + firstTab(role))`, waits 300 ms for layout, then shows step 0. Finish or skip → `update(userId, { tourDone: true })`.

Behaviour:
- Overlay root: `StyleSheet.absoluteFill`, `pointerEvents="box-none"` when nothing shows. While a tour shows, a full-screen `Pressable` swallows touches and the card sits on top.
- Card: `accessibilityViewIsModal`, `accessibilityRole="none"` on the root, title `accessibilityRole="header"`. Focus goes to the title on each step (`AccessibilityInfo.setAccessibilityFocus`). Dots are hidden from TalkBack. The label is `Step {n} of {total}`. Buttons: Back (from step 2), Next, last step "Start using Tonnage" (supervisor: "Start weighing"). A "Skip tour" pill sits top-right below the status bar inset. Every control is ≥ 44 dp.
- `BackHandler`: previous step; on step 0 it ends the tour.
- Hide (do not end) while `openSheets > 0` or session `status !== 'signedIn'`, and resume after. End on sign-out or identity change.
- Hole animation: `Animated.timing` 300 ms between rects; instant with reduce motion.

- [ ] **Step 1: Write failing tests** (render `TourProvider` around a fake screen with `TourTarget`s; mock `measureInWindow`; mock `expo-router` `useRouter` as in `shell.test.tsx`):
  - `Next and Back move through the owner steps`: titles in order, Back absent on step 1.
  - `Android Back goes to the previous step and on step 1 ends the tour` (`BackHandler` mock emits `hardwareBackPress`).
  - `Skip tour ends it and sets tourDone`.
  - `the last button sets tourDone and closes`.
  - `a step whose target is missing renders the card centred with no hole` (path has one subpath).
  - `touches outside the card do not reach the screen` (a button under the overlay is not pressed).
  - `the tour hides while a Sheet is open and comes back after` (Review Focus 1).
  - `signing out mid-tour closes it; the next person starts fresh` (Review Focus 2).
  - `a target that moves re-measures on layout` (fire `onLayout` with a new rect; the hole follows) (Review Focus 3).
  - `a11y audit passes on the coach card` (use `test/a11y/audit.ts`).
- [ ] **Step 2: Run** `pnpm --filter mobile exec jest test/onboarding-tour.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, then mount the provider in `app/(app)/_layout.tsx` inside the `View`, above the Stack, before `ToastHost` (toasts stay on top).
- [ ] **Step 4: Run** this test, plus `test/contrast.test.ts` and `test/dark-theme.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): spotlight tour engine and coach card`

---

### Task 5: Put targets on the real screens

**Files:**
- Modify: `src/screens/home/HomeScreen.tsx` (unit pill → `home.units`; pending `Group` → `home.pending`; `InPlantSection` → `home.inPlant`; `Bell` → `home.bell`)
- Modify: `src/ui/TabBar.tsx` (each tab item → `tab.<key>`)
- Modify: `src/screens/supervisor/TasksScreen.tsx` (counts row → `tasks.counts`; on the **first** task card only: the Vehicle arrived button → `tasks.arrived`, the tare step → `tasks.tare`, the weigh action → `tasks.weigh`)
- Modify: `OrderDetailScreen.tsx` (Request vehicle → `order.requestVehicle`), `DispatchScreen.tsx` (the To approve chip → `dispatch.toApprove`), `TruckDetailScreen.tsx` (`SupervisorCard` → `truck.supervisors`), the broker ledger screen (Record payment → `ledger.recordPayment`), `reports` screen (first tile), `attention` (first row), notifications list, `LineWeightsStep` (`weigh.lines`), `DoneTodayScreen` (`done.list`)
- Test: `apps/mobile/test/onboarding-targets.test.tsx`

- [ ] **Step 1: Write a failing test.** Render `HomeScreen` (owner, mock with `seedOrders: true`), `TabBar` for owner and supervisor, and `TasksScreen` for Ravi with a seeded task. Assert `targetsStore` holds every `TargetId` that the role's `stepsFor` uses (all of them except steps without a target).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Wrap the elements.** Wrapping must not change layout: `TourTarget` passes `style` through. In `TabBar`, wrap the `Pressable` and give the wrapper `flex: 1`.
- [ ] **Step 4: Run** the new test and the full mobile suite (`pnpm --filter mobile exec jest`). Expected: PASS, with no snapshot or a11y regressions.
- [ ] **Step 5: Commit** `feat(mobile): tour targets on home, tabs, tasks and tip screens`

---

### Task 6: Welcome back (board 41)

**Files:**
- Create: `apps/mobile/src/onboarding/WelcomeScreen.tsx`, `welcomeLine.ts`
- Modify: `TourProvider.tsx` (when the welcome shows), `src/notifications/usePush.ts` (call `dismissWelcome()` inside `open`)
- Test: `apps/mobile/test/onboarding-welcome.test.tsx`

**Interfaces:**
- Produces:
  - `welcomeLine(role, data: { pendingKg?: number; inPlant?: number; waiting?: number }, basis): string`
    - owner / city_staff: `"{qty} {unit} pending to dispatch"`, or `"Nothing pending to dispatch"` at 0
    - plant_head: `"{n} truck(s) in plant now"`
    - supervisor: `"{n} truck(s) waiting for you"`, or `"No trucks waiting yet"`
    - data undefined: `"Getting today's work ready…"`
  - `roleBadge(me, companies, plants): string`: `Owner · All units`, `City staff · All units`, `Plant head · {plant names}`, `Supervisor · {company short}, {plant}`
  - `dismissWelcome(): void` (module function)
- Rules: show when the provider mounts with `useSession.resumed === true` and status `signedIn`, once per app run. Also show on every `locked → signedIn` transition. Never after a fresh sign-in (`resumed === false`). Visible at least `WELCOME_MIN_MS = 900` once the line is ready, at most `WELCOME_MAX_MS = 1800`. Fade out over 250 ms (instant with reduce motion). **No tap dismisses it**: the root is not pressable, and it swallows touches while shown. `dismissWelcome()` hides it at once. After it hides, the intro shows if `!introSeen`.
- Look: board 41 tokens. Logo mark built from 4 unit colours with `unitBarColor`. "Tonnage" 36/40 bold. Tagline "ORDER · LOAD · DISPATCH". "Welcome back" with a check icon. First name 40 semibold in `t.brt`. Role badge pill with a role dot (owner `br`, city staff `te`, plant head `ok`, supervisor `wn`). Live line with a spinner (`ActivityIndicator`, hidden with reduce motion). `accessibilityRole="alert"`, label `Welcome back, {name}`.

- [ ] **Step 1: Write failing tests** (fake timers; `useSession.setState`):
  - `shows on a resumed cold start with name, badge and live line`. Owner seeded: `"… MT pending to dispatch"` uses `toDisplayQty`.
  - `does not show after a fresh sign-in` (`resumed: false`).
  - `shows again after unlock` (`status` `locked` → `signedIn`).
  - `stays at least 900 ms and at most 1800 ms` (`advanceTimersByTimeAsync`).
  - `a tap does not dismiss it` (press at its root; still shown at 800 ms).
  - `a notification open dismisses it at once` (call `dismissWelcome()`, then gone) (Review Focus 5).
  - `the intro follows when introSeen is false`.
  - `welcomeLine` unit cases for each role, including kg basis and the singular "1 truck".
  - `a11y audit and dark palette pass`.
- [ ] **Step 2: Run** `pnpm --filter mobile exec jest test/onboarding-welcome.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Live data: `useHome()` for office roles, `useDeviceSnapshot()` for supervisors (`shown.length`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): welcome back on reopen and unlock`

---

### Task 7: Tour intro (board 42)

**Files:**
- Create: `apps/mobile/src/onboarding/TourIntroSheet.tsx`
- Modify: `TourProvider.tsx`
- Test: `apps/mobile/test/onboarding-intro.test.tsx`

**Interfaces:** Consumes `INTRO`, `tourSummary`, `useTour().startTour`, `onboardingStore.update`.

The intro uses `Sheet` with a custom `header`: an overline "WELCOME TO TONNAGE" in `brt`, and a 24/30 semibold heading with the first name in `brt`. Three point rows use `IconTile`. Then a primary button "Start tour · 1 min", a ghost button "Skip for now", and a caption "Replay anytime from More → Help & tour" (supervisor: "Profile → Help & tour"). It shows when the store has hydrated, `introSeen` is false, no welcome is showing, and status is `signedIn`.

- [ ] **Step 1: Write failing tests:** `shows once on first sign-in`; `Skip sets introSeen and it does not return after remount`; `Start sets introSeen and starts the tour on the first tab` (`mockRouter.navigate('/home')`, or `/tasks` for a supervisor); `supervisor caption says Profile`; `a11y audit passes`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): first sign-in tour intro`

---

### Task 8: First-visit tips (board 45)

**Files:**
- Create: `apps/mobile/src/onboarding/useFirstTip.ts`, `TipBubble.tsx`
- Modify: each screen from Task 5 that has a tip: call `useFirstTip('<key>')`
- Test: `apps/mobile/test/onboarding-tips.test.tsx`

**Interfaces:**
- Produces: `useFirstTip(key: TargetId): void`. On screen focus (`useFocusEffect`), after `TIP_SETTLE_MS = 600`, it asks the provider to show the tip if: `tipFor(role,key)` exists, `tipsOn` is true, the key is not in `tipsSeen`, the overlay is `'none'`, `openSheets === 0`, the target rect is registered, and no tip has shown on this screen visit. "Got it", or leaving the screen, marks it seen. Showing also marks it seen, so a tip is never shown twice even if the app is killed.
- Bubble: `tipBg` / `tipTx`. A "NEW" chip (`inv` / `invtx`), title 15 semibold, body 13/19 `tipTx2`, "Tip · shown once" caption, and a "Got it" button ≥ 44 dp. An arrow points at the target, placed with `placeCard` logic against the target rect. A pulsing dot sits at the target's edge (static with reduce motion). `accessibilityLiveRegion="polite"`. Touches pass through to the screen except on the bubble.

- [ ] **Step 1: Write failing tests:** `shows once, Got it marks seen, never again`; `not shown while the tour or welcome shows, or a sheet is open, and shown after they close` (Review Focus 1); `not shown when tipsOn is false`; `not shown to a role without the action` (plant head on order detail); `only one tip per visit`; `a11y audit passes`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): first-visit tips`

---

### Task 9: Help & tour (board 46)

**Files:**
- Create: `apps/mobile/app/(app)/help.tsx`, `src/screens/help/HelpTourScreen.tsx`, `TeamTourPreview.tsx`, `HowToSheet.tsx`
- Modify: `src/screens/MoreScreen.tsx` (a "Help & tour" `MenuRow`, icon `info`, tone `gr`, in the last group above the "Tonnage" row, for every role), `src/screens/ProfileScreen.tsx` (the same row for supervisors)
- Modify: `TourProvider.tsx` (`startPreview(role)`: the same CoachCard in a full-screen pager over `t.scrim` with no hole and steps from `stepsFor(role, '')` with "{name}" lines dropped; the last button is "Close")
- Test: `apps/mobile/test/onboarding-help.test.tsx`

Screen sections, matching board 46:
1. **Replay your tour**: "Owner · 8 steps · about 1 min" → `startTour()`.
2. **What your team sees** (only when `can(role,'users.manage') || role === 'city_staff'`, i.e. owner and city staff; there is no action for this, so here a role check is allowed and must carry a comment saying why): one row per other office or plant role with "{n} steps · {summary}" → `startPreview(role)`.
3. **How do I…**: `howToFor(role)` rows → `HowToSheet` with numbered steps, and a "Show me" button when `showMe` is set (closes the sheet, `router.push(showMe)`).
4. **Show tips on new screens** (`Switch`, bound to `tipsOn`) and **Show all tips again** (clears `tipsSeen`, toast "Tips will show again").

- [ ] **Step 1: Write failing tests:** `More shows Help & tour for owner, city staff and plant head; Profile for the supervisor`; `replay starts the tour`; `team previews only for owner and city staff; the plant head sees none`; `How do I opens the steps and Show me navigates`; `the tips switch persists; Show all tips again clears tipsSeen`; `a11y audit passes in light and dark`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): Help & tour with team previews and how-to`

---

### Task 10: Demo tools, docs, full verification on the emulator

**Files:**
- Modify: `src/screens/DemoToolsScreen.tsx` (a "Replay first sign-in" row: `onboardingStore.reset(me.id)` and a toast "First sign-in will show again". Then call `useSession.setState({ resumed: true })`, which re-arms the welcome for this run, followed by the intro.)
- Modify: `CLAUDE.md` (a short "Welcome & tours" bullet under Architecture; Demo tools line), `CHANGELOG.md`
- Test: extend `apps/mobile/test/demo-tools.test.tsx`

- [ ] **Step 1: Write a failing test:** `Replay first sign-in clears only this person's progress and shows the welcome then the intro`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Run the full checks from the repo root:** `pnpm lint`, `pnpm typecheck`, `pnpm test`. Expected: all green.
- [ ] **Step 6: Manual pass on the emulator** (`npx expo start --localhost`, `adb reverse tcp:8081 tcp:8081`, open `exp://127.0.0.1:8081`). For each of Rajesh, Amit, Kiran and Ravi:
  - Reset demo data, sign in, take the intro and tour, then check that every hole sits on its target.
  - Open each tip screen once.
  - Close and reopen the app and check the welcome.
  - Turn on Graphite dark and Large text, and repeat the tour for the owner and the supervisor.
  - Fix any misplacement, then screenshot the result.
- [ ] **Step 7: Commit** `chore(mobile): demo replay, docs and changelog for welcome & tours`. Then move the Notion card to Review.
