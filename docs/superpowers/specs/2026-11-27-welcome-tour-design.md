# Welcome, role tours and first-visit tips — design

Date: 2026-11-27 · Branch: `feat/welcome-tour` · Canvas row "Welcome & tutorial", boards 41–46 ·
Notion card "Welcome screen, role tours and first-visit tips (canvas 41–46)".

## Intent

Two audiences, one feature:

- **The client demo.** Opening the app should feel finished and personal: a branded welcome with
  the person's name and one live line, then a short guided tour that shows the product's value
  for each role.
- **Real staff on their own, first time.** Owner, city staff, plant head and supervisor must be
  able to find their way without someone beside them. Supervisors especially (plant floor, often
  first smartphone work app) need the arrive → tare → product weights → approval flow explained
  on the real screen.

Success: a new person of any role signs in, takes a 1-minute tour over their real screens, gets a
one-line tip the first time they open each important screen, and can replay or look things up
later from Help & tour. Nothing in it blocks or slows real work.

## Goals

- Board 41 **Welcome back** on every app open, per role, with a live line from real data.
- Board 42 **Tour intro** once per person per phone on first sign-in.
- Boards 43–44 **Spotlight tours** for **all four roles** (owner, city staff, plant head,
  supervisor), over the real app.
- Board 45 **First-visit tips**: one small tip the first time a key screen opens, once each.
- Board 46 **Help & tour**: replay my tour, preview the other roles' tours (owner, city staff),
  "How do I…" answers per role, tips on/off, show all tips again. In More (owner, city staff,
  plant head) and Profile (supervisor).
- Copy brought up to date with the app as built (TON-57 and later), not the canvas's older text.

## Non-goals

- No server state: progress is per person **on this phone** (AsyncStorage). A new phone shows the
  intro again, which suits staff who change phones. No contract or API change.
- No video, no external help site, no chat.
- No tour for screens behind sign-in that the role cannot reach (policy decides).
- Sign-up / fresh-start screens (canvas 47–55) are a separate card.

## Anti-goals (a failure even if it works)

- A tour or tip that covers something the person needs right now (a sync error, a sheet they
  opened, the lock screen).
- Welcome screen that delays the app: it never waits on the network longer than its own short
  window, and a tap skips it.
- Text that describes something the app no longer does (e.g. "save to dispatch" for supervisors).
- Raw colours, inaccessible controls, or motion when the phone has Remove animations on.

## Constraints

- Expo Go only; no new native modules. `react-native-svg` 15.16 is already installed (used for
  the spotlight cut-out). No new dependency.
- Every colour from `tokens.ts` (lint); light and Graphite dark; text pairs WCAG AA
  (`contrast.test.ts`); every new screen passes `test/a11y/audit.ts`.
- Policy-driven: steps, tips and "How do I…" topics are filtered with `can(role, action)` and
  `tabsForRole(role)`, never by hard-coded role checks where an action exists.
- Copy follows the canvas voice; names in Caveat are replaced by our Inter semibold (Caveat is
  not loaded in the app; adding a font for one word is not worth it — **my call**).
- Business time zone IST for "today" numbers on the welcome line.

## Approaches considered

1. **Spotlight over the real app (chosen).** `TourTarget` wrappers report their window rect; one
   overlay dims the screen with an SVG even-odd path that leaves a rounded hole over the target,
   and places the coach card above or below. Teaches the real screen with real data, works in
   dark and large text, and stays right as screens evolve.
2. **Illustrated carousel** (static pictures as in the canvas). Robust, but goes stale with every
   screen change (the canvas already has) and doesn't teach where things are.
3. **Third-party tour library.** Less code, but styling fights our token lint and a11y audit, and
   Expo Go compatibility is uncertain.

The user handed the how to me; option 1 is my pick.

## Design

### Module layout

`apps/mobile/src/onboarding/` (pure parts testable without React):

- `store.ts` — zustand + AsyncStorage key `tonnage.onboarding`, `{ [userId]: { introSeen,
  tourDone, tipsOn, tipsSeen: string[] } }`, same hydrate/sanitize pattern as `unitFilter.ts`.
  `resetOnboarding(userId?)`. Cleared by **Reset demo data**.
- `tours.ts` — pure step data per role: `{ id, target?, tag, title, body, requires? }`;
  `stepsFor(role, name)` filters by policy and tabs. Copy lives here.
- `tips.ts` — tip catalogue `{ key, screen, target, title, body, requires? }`.
- `howTo.ts` — "How do I…" topics per role: title, 3–5 numbered steps, optional "Show me" route.
- `TourProvider.tsx` — context mounted in `app/(app)/_layout.tsx` above the Stack: target
  registry, the active tour, the active tip, the welcome state. Rendered as an in-tree absolute
  overlay (not a `Modal`), so the lock screen still covers it.
- `TourTarget.tsx` — wraps a view; on layout and on step change calls `measureInWindow` and
  registers `{ id → rect }`. Unregisters on unmount.
- `SpotlightOverlay.tsx` — SVG scrim (`t.scrim`-based token, new `spot` tokens if needed) with an
  even-odd rounded-rect hole and a 3 dp ring; animates between targets with `Animated` (instant
  when reduce motion is on). Touches outside the card are swallowed.
- `CoachCard.tsx` — tag chip, progress dots, title, body, Back / Next / "Start using Tonnage";
  "Skip tour" pill top-right. Placed below the hole if it fits, else above, else centred.
- `WelcomeScreen.tsx` (board 41), `TourIntroSheet.tsx` (42, uses `Sheet`), `TipBubble.tsx` (45),
  `HelpTourScreen.tsx` (46, route `app/(app)/help.tsx`), `TeamTourPreview.tsx`, `HowToSheet.tsx`.

### When things appear

Precedence, one at a time: **lock screen > welcome > intro > tour > tip**. Nothing appears while a
sheet/modal is open or while the lock screen is up; it waits.

- **Welcome back (41):** whenever the app is closed and reopened while the person is still signed
  in (the session resumes from the 60-day refresh token; nobody is signed out), and after
  unlocking from the idle lock. Not after a fresh sign-in (the intro follows instead), not when the app opened from a
  tapped notification (it goes straight to the link). Shows for 1.5 s from when it is on screen (user decision 2026-11-27), then fades out. It cannot be skipped by a tap (user decision 2026-11-27); the max window keeps it short. Content: logo mark, "Welcome back", first
  name, role badge (`Owner · All units`, `Plant head · Siltara`, `Supervisor · Aarav, Siltara`),
  and a live line from data the app already loads:
  - owner / city staff: pending to dispatch in the viewer's unit basis, or "N to approve" when
    trucks await approval;
  - plant head: "N trucks in plant now";
  - supervisor: "N trucks waiting for you" (from the device store, works offline);
  - fallback "Getting today's work ready…". Spinner is static with reduce motion.
- **Tour intro (42):** first sign-in of this person on this phone, over their first tab. Three
  role-specific value points, "Start tour · 1 min", "Skip for now", "Replay anytime from
  More → Help & tour" (supervisor: Profile). Either choice sets `introSeen`.
- **Tour (43–44):** starts from the intro or Help & tour. Navigates to the role's first tab first.
  Steps whose target is not on screen (e.g. no task card for a supervisor) show the card centred
  with no hole and copy that still makes sense. Android Back = previous step; on step 1 it ends
  the tour. Finishing or skipping sets `tourDone`.
- **Tips (45):** the first time a screen in the catalogue is focused, after a 600 ms settle, if
  `tipsOn` and no tour/sheet/welcome is showing and the target is on screen: one dark bubble with
  a "NEW" chip, title, line, "Got it", arrow pointing at the target, pulsing dot (static with
  reduce motion). Shown once (`tipsSeen`), never two on one visit. Tips show from the first
  visit, not held back for a day, since the tour only covers the basics (**my call**).

### Tours (copy written for the app as built)

All steps live on the role's first tab plus the tab bar, so the tour never navigates mid-way.

**Owner** (8): Units switcher · Pending to dispatch (split by company, older than 10 days) ·
In plant now (live from supervisors) · New (order, loading, request, masters) · Orders ·
Dispatch (board by stage; **To approve**: a supervisor's saved weights wait for your approval,
which dispatches the truck and gives the loading slip number) · More (broker ledger, reports,
Needs attention, admin, Help & tour) · Done ("Small tips appear the first time you open a
screen").

**City staff** (7): Units · Pending · New · Orders · Dispatch (To approve, as above) · More
(broker ledger and payments, reports, Help & tour) · Done.

**Plant head** (5): Home for your plants · In plant now · Orders (your plants' orders, no prices)
· Dispatch (follow every truck at your plants) · More (Help & tour, settings) · Done.

**Supervisor** (7): Counts (need tare / need gross / done today, only your plant) · Vehicle
arrived (mark it at the gate first) · Capture tare (unlocks after arrival) · Product weights (one
weight per product line; you can add another line of the same order; gross is worked out) ·
Awaiting approval (after you save, the office approves and the truck is dispatched; your part is
done) · Done tab (works offline, syncs when the network is back) · Ready.

Final wording is settled in the plan and reviewed against the running app; it must not mention
"Gross weighed" or "save to dispatch".

### Tips catalogue (policy-gated)

| Screen | Target | Tip | Needs |
|---|---|---|---|
| Order detail | Request vehicle | Ask the broker or customer for a truck by call or WhatsApp; material and MT are filled in | `truck.assign` |
| Dispatch board | To approve chip | Trucks with saved weights wait here; approving dispatches them | `dispatch.approve` |
| Truck detail | Supervisors card | Call or WhatsApp the plant's supervisor from here | `dispatch.view` |
| Broker ledger | Record payment | Record a payment with TDS; the due updates at once | `broker.pay` |
| Reports | first tile | Pick a date range, then Share | `reports.view` |
| Needs attention | first row | Weights the server refused: restore or dismiss | `rejections.manage` |
| Notifications | list | Tap one to open the order or truck | — |
| Weigh (capture) | line weights | Type each product's weight; gross is added up for you | `tasks.view` |
| Done today | list | Saved on this phone; it syncs when you're online | `tasks.view` |

### Help & tour (46)

Route `/help`. Rows: **Replay your tour** (`Owner · 8 steps · about 1 min`) → starts the tour on
the first tab. **What your team sees** (owner and city staff only): the other three roles' tours
as a preview — the same coach cards in a full-screen pager over a dimmed role-coloured backdrop,
no spotlight (their screens are not on this phone). **How do I…**: 4–6 topics for the role, each a
sheet with numbered steps and, where it helps, "Show me" that opens the screen. **Show tips on
new screens** switch and **Show all tips again** (clears `tipsSeen`, toast "Tips will show
again"). Entry: More → "Help & tour" row (all three office roles); supervisor Profile → same row.

### Demo tools

"Replay first sign-in" (resets onboarding for the current person and shows welcome → intro), so
the client demo can show it at will. Reset demo data clears every person's onboarding state.

### Accessibility

Coach card and intro are announced as dialogs; focus moves to the card title on each step; the
dimmed area is hidden from TalkBack; every control ≥ 44 dp; tip bubble is a polite announcement
with "Got it" reachable; Android Back handled everywhere; reduce motion removes slides, pulses and
the spinner. Large text: card grows; placement re-measures.

### Testing (jest + RNTL, tests first)

- store: hydrate/sanitize, per-person, reset, Reset demo data clears it.
- tours: `stepsFor` per role matches policy/tabs; no step text contains retired phrases.
- welcome: shown on cold start / after unlock, not after fresh sign-in or notification open;
  min/max timing with fake timers; a tap does not dismiss it; live line per role.
- intro once per person; Start / Skip both set `introSeen`.
- tour: Next / Back / Skip / Android Back; missing target → centred card; finishing sets
  `tourDone`; overlay blocks touches outside the card.
- tips: once per key, suppressed during tour / welcome / sheet, off switch, show-all-again.
- Help & tour: replay starts tour; team previews only for owner and city staff; How do I sheets.
- a11y audit and dark theme test over every new screen; `pnpm lint`, `typecheck`, `test` green.
- Manual: run each role in Expo Go on the emulator, light and dark, large text.

## Left to the builder

Exact animation timings, card placement maths, the SVG hole radius per target, the "How do I…"
step wording (reviewed in the plan), and token additions (named, both palettes, contrast-tested).
