# F5 — Notifications, Push, Background Sync, Dark Theme, Accessibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every role an in-app notification list with simulated push, keep the supervisor phone synced in the background, polish the Graphite dark theme, and make the app pass an accessibility audit, all still in Expo Go on the mock API.

**Architecture:** Notifications follow the spec's server shape (§4 `notifications`, `notification_outbox`; §5.7 "sent only after commit"). The mock writes notification rows and push-outbox rows inside the same transactional handler as the business change. After a request commits, a mock push worker drains the outbox to the devices registered for each user. The app receives pushes through one `PushChannel` seam (mock subscription now, Expo push in B4), shows visible ones as local notifications (expo-notifications), and turns silent ones into a sync. Background sync is an expo-background-task that runs the existing sync engine under a lock shared with the foreground loop. Dark theme and accessibility are made checkable by tests: a colour-matrix render test, a token contrast test, and an a11y audit helper run over every screen.

**Tech Stack:** Expo SDK 58 (Expo Go), Expo Router, TanStack Query, Zustand, expo-notifications, expo-background-task + expo-task-manager, zod (`packages/shared`), vitest (packages), jest + RNTL 14 (`apps/mobile`).

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md`. Read §4 (Cross-cutting: `notifications`, `notification_outbox`, `devices`), §5.3 hard delete (removes notifications), §5.5, §5.6 (notifications follow the unit basis), §5.7 (outbox after commit), §6.3–6.4 (silent "truck assigned" push, Android periodic task ~15 min), §7 (notifications: list, mark read, register push token), §7.1, §8.2, §8.4 (tokens, Large ×1.15, accessibility line), §8.6, §12 (F5 row). Decisions register https://claude.ai/artifact/7f2fd784-5809-4ac7-ba0f-42a25abdba23 §9: push Default = "New order for my plant, truck assigned, dispatched, aged order, over/under loading". Canvas https://claude.ai/artifact/1cf17fda-d3a4-498b-b46d-c67fdc49f795: board 37 `Notifications.dc.html` (list, copy, tiles), board 15 `HomeDark.dc.html` (Graphite dark, Home bell "Notifications, 3 new"), board 39 (scrim values). Local copies: `.superpowers/sdd/f5-canvas/project/`.

**Not in F5 (dropped by the client):** Excel import, tablet split views, client demo APK. F4 Task 7 (exports) stays on hold.

## Rulings

1. **Expo Go only (option A).** No dev build. Real Expo push needs a dev build plus FCM and a server that sends; that is B4. In F5 the mock is the push server: its worker emits `PushMessage`s in-process; the app shows visible ones with `Notifications.scheduleNotificationAsync({ content, trigger: null })`. B4 swaps only the `PushChannel` implementation (Task 6).
2. **Kinds and recipients.** The actor never gets their own notification. Recipients are filtered by scope (a plant head only for plants they hold; out of scope = nothing, never a redacted copy). Money kinds go to money roles only (`can(role, 'money.view')`).

   | kind | when (mock hook) | recipients |
   |---|---|---|
   | `order.created` | `POST /v1/orders` commit | owner; plant heads whose plants belong to a sub-order's company |
   | `truck.assigned` | assign | plant heads of the truck's plant; supervisors of that plant also get a silent `sync` push and a list row |
   | `truck.dispatched` | GROSS accepted | owner; the order's creator if city staff; plant heads of the plant |
   | `order.over_tolerance` | GROSS makes `overToleranceKg > 0` (existing `order.over_tolerance` activity point) | owner; the order's creator if city staff |
   | `order.short_closed` | short close commit | owner; the order's creator if city staff; plant heads of affected plants |
   | `broker.payment_recorded` | payment commit | owner and city staff (money roles) |
   | `rejection.created` | a sync event becomes a rejection | owner (`rejections.manage`) |
   | `orders.aged` | daily digest (Ruling 6) | owner and city staff |

   Silent `sync` pushes (no row) also go to that plant's supervisors on truck edit, truck cancel, short close that cancels open trucks, and order delete with trucks.
3. **Copy (board 37), rendered on the device** by `renderNotification(n, basis, tz)` so a unit-basis change re-renders with no refetch (§5.6). Quantities through `toDisplayQty(kg, basis, { withUnit: true })`; ₹ through `formatRupees`; time `HH:mm` IST.

   | kind | title | body |
   |---|---|---|
   | `truck.dispatched` | `{vehicleNo} dispatched` | `{netQty} to {partyName} · {companyName} · {time}` |
   | `order.over_tolerance` | `Over-loaded by {overQty}` | `{subOrderNumber} · {partyName} · allowed` |
   | `order.created` | `New order {orderNumber}` | `{actorFirstName} · {partyName} · {qty} · {codes joined " + "}` |
   | `orders.aged` | `{n} order(s) older than {days} days` (`1 order`, `6 orders`) | `{pendingQty} still pending · tap to review` |
   | `broker.payment_recorded` | `{paidRupees} paid to {brokerName}` | `{MODE} · recorded by {actorFirstName} · {dueRupees} still due` (negative due → `Advance {abs}`) |
   | `order.short_closed` | `{subOrderNumber} short closed` | `{closedQty} stopped · {partyName}` |
   | `truck.assigned` | `{vehicleNo} assigned` | `{plannedQty} planned · {partyName} · {plantName}` |
   | `rejection.created` | `Weight not accepted · {vehicleNo}` | `{reason from messages.ts for the code} · Needs attention` |

   `partyName` = customer name, else broker name. For plant heads, `qty`/`codes` cover only their in-scope sub-orders (the mock builds `data` per recipient). Tiles: dispatched `gr`/`check`, over `am`/`scales`, created `bl`/`orders`, aged `rd`/`clock`, payment `vi`/`wallet`, short closed `am`/`ban` (new icon, board 37 path), assigned `bl`/`truck`, rejection `rd`/`alert`.
4. **Deep links** are stored per recipient (`deepLink`, spec column) by shared `deepLinkFor(kind, data, role)`: created/over/short-closed → `/orders/{orderId}`; dispatched → `/trucks/{truckId}`; assigned → `/trucks/{truckId}` (plant head), `/tasks` (supervisor); aged → `/orders?aged=1`; payment → `/parties/{brokerId}`; rejection → `/attention`. The app navigates only if the link matches `isAllowedDeepLink` (Task 4). Anything else opens the Notifications screen. A target that is gone (deleted order) shows the screen's normal "Not found".
5. **List and read state.** `GET /v1/notifications?cursor=` newest first, page 30, last 30 days only. `GET /v1/notifications/unread-count` → `{ count }`. `POST /v1/notifications/:id/read` and `POST /v1/notifications/read-all` are idempotent; another user's id → 404. Action `self.view` (every role sees only their own rows). The app groups rows by IST date: `Today`, `Yesterday`, then `d MMM`. Unread dot as board 37. The badge shows the count, `9+` above 9.
6. **Aged digest.** The B4 job runs at 09:00 IST. The mock runs it lazily at the start of any authenticated request, once per tenant per IST date, when the IST time is ≥ 09:00 and the tenant's aged-order count > 0 (`tenant.lastDigestDate` in state). Recipients are owner and city staff; plant heads are excluded (spec pushes "aged orders" to the owner side).
7. **Push tokens and devices.** `POST /v1/notifications/push-token { deviceId, token }` (upsert per user + device) and `DELETE /v1/notifications/push-token/:deviceId`. In mock mode the token is `mock:{deviceId}`. The app registers after sign-in and after a person switch, and unregisters before sign-out. Unregistering is best-effort (offline sign-out still signs out; the server drops tokens of revoked refresh sessions). The mock worker delivers each outbox row to every token of the recipient; the app accepts only messages addressed to its own token.
8. **Push permission.** On Android 13+, ask once after the first sign-in on the phone (`requestPermissionsAsync`). A refusal is respected: the list and badge still work. Settings → Notifications shows "On" / "Off — open phone settings" (`Linking.openSettings()`). Supervisor Profile gets the same row.
9. **Foreground behaviour.** A visible push while the app is open shows the system banner (`setNotificationHandler` → `shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false`) and invalidates the notifications queries. Tapping a notification marks it read and opens its deep link (Ruling 4).
   **Task 1 finding:** local notifications work in Expo Go. Permission is asked with the system dialog ("Allow Expo Go to send you notifications?"), and `scheduleNotificationAsync(..., trigger: null)` shows at once. A tap while the app runs reaches `addNotificationResponseReceivedListener` with `content.data` intact. Android groups several notifications under "Expo Go"; tapping the collapsed group summary opens the app without a response event, so `usePush` also reads `getLastNotificationResponseAsync()` on mount (cold start) and de-duplicates by notification id.
10. **Background sync.** `expo-background-task` task `tonnage-sync`, `minimumInterval: 15` (minutes), registered while a capture role (`CAPTURE_ROLES`) is signed in and unregistered on sign-out. The task body: if the foreground loop is running → `syncNow()`; else open that user's device store, run the engine once, close it. Foreground loop and task share one `withSyncLock` (Task 7). If Task 1 finds background tasks unavailable in Expo Go, the code still ships, registration is skipped when `getStatusAsync()` is not `Available`, and Demo tools "Run background sync now" exercises the same body.
   **Task 1 finding (2026-11-19, Expo Go on Android emulator, SDK 58):** `getStatusAsync()` returns `Restricted` (1). `registerTaskAsync` succeeds and `isTaskRegisteredAsync` is `true`, but the body never runs: `triggerTaskWorkerForTestingAsync` is refused ("Background tasks cannot be triggered in production builds"), and forcing the WorkManager job with `adb shell cmd jobscheduler run -f host.exp.exponent 0` runs the job without calling our task. So in Expo Go, `registerBackgroundSync()` skips registration (status not `Available`), and Demo tools "Run background sync now" is how the body is exercised. Real background sync is verified in a dev build/APK (B milestones).
11. **Hard delete** removes every notification whose `data.orderId` is the deleted order, and every outbox row not yet sent for it (§5.3).
12. **Dark theme (board 15).** New tokens, both themes: `tabBar` (light `#FFFFFF`, dark `#0D0D10`), `scrim` (light `rgba(11,13,18,.42)`, dark `rgba(0,0,0,.6)`), `shadow` (light `#0B0D12`, dark `#000000`), `onDanger` `#FFFFFF`, `thumb` `#FFFFFF`, `highlight` (light `transparent`, dark `rgba(255,255,255,.04)`: the group's 1 px top highlight). Home's pending bar colours per slot come from `unitBarColor(slot, scheme)`: dark `#4F86F7 #9B85F5 #26A69A #E5A93B`, light = `br vi ok wn` of the light tokens. No raw colour literal outside `src/theme/tokens.ts` (lint rule, Task 8).
13. **Contrast.** Text pairs ≥ 4.5:1, large text (≥ 18.66 px semibold or ≥ 24 px) and icons ≥ 3:1, in both themes. When a canvas pair fails, the text token moves to the nearest value that passes in the same hue, and the change is listed in `tokens.ts` with the old value.
14. **Accessibility scope.** TalkBack: every pressable has a role and a name; headers marked; states (selected, checked, disabled, expanded) set; decorative icons hidden. Touch targets ≥ 44 dp (`MIN_TOUCH`). Status never by colour alone. Live regions: weight readout (spec), sync banner, toasts, form errors. Reduced motion: sheets fade instead of slide. Large text: app Large (×1.15) and Android font scale 1.3 and 2.0 show no clipped numbers, buttons or labels (wrapping allowed).

## Global Constraints

- Expo Go only; no custom native modules. Expo SDK modules that ship in Expo Go are allowed, installed with `npx expo install` (expo-notifications, expo-background-task, expo-task-manager). Restart Metro with `--clear` after adding them.
- The app talks to a backend only through `Transport`; push only through `PushChannel` (Task 6).
- `packages/shared` and `packages/mock-api` import nothing from React Native or Expo.
- Quantities are integer kg, money integer rupees; format only with `packages/shared/src/units.ts` / `format.ts`. Business time zone `Asia/Kolkata`.
- Money fields named explicitly (`paidRupees`, `dueRupees`); never a generic `value`.
- Out-of-scope records are 404, never 403. Every route declares `action` or `public: true`.
- A behaviour change starts with a contract test (`packages/contract-tests`).
- Colours, copy and spacing from the canvas via tokens; never raw hex.
- Conventional Commits with scope; tests first; scripts work in Git Bash and PowerShell.
- RNTL 14: `await` every `fireEvent.*` and `unmount()`; pin time with `jest.spyOn(Date, 'now')`.

## Review Focus

1. **A write that rolls back** (transactional handler throws after the notification was written) → no notification row and no push. Test in Task 3.
2. **Person switch on one phone** (owner → supervisor in Demo tools) → the old person's pushes stop and the new person's arrive; no notification of one shows for the other. Test in Task 6.
3. **Background task fires while the foreground loop is mid-sync** → one run at a time, each outbox row sent once. Test in Task 7.
4. **Unit basis switched to kg with the list open** → every row re-renders in kg, with no refetch. Test in Task 5.
5. **Plant head of Siltara and an order with only Borai sub-orders** → no notification at all; a payment notification never reaches a plant role; a supervisor's `data` carries no ₹ field. Test in Task 3.

## File Structure

```
packages/shared/src/notifications/
  kinds.ts        NOTIFICATION_KINDS, NotificationData per kind (zod), notificationSchema, pages, push message schema
  recipients.ts   recipientsFor(event, world) pure
  render.ts       renderNotification(n, basis) → { title, body }; tileFor(kind)
  links.ts        deepLinkFor(kind, data, role); isAllowedDeepLink(path)
packages/mock-api/src/notifications.ts      notify(state, ctx, event) → rows + outbox; drainOutbox; daily digest
packages/mock-api/src/handlers/notifications.ts   routes
packages/contract-tests/src/suites/notifications.contract.ts
apps/mobile/src/api/hooks/notifications.ts
apps/mobile/src/notifications/   pushChannel.ts, usePush.ts, permission.ts, localNotify.ts
apps/mobile/src/screens/notifications/NotificationsScreen.tsx, NotificationRow.tsx, Bell.tsx
apps/mobile/app/(app)/notifications.tsx
apps/mobile/src/offline/syncLock.ts, backgroundSync.ts
apps/mobile/src/theme/contrast.ts
apps/mobile/test/a11y/audit.ts (helper), test/a11y.test.tsx, test/dark-theme.test.tsx, test/notifications.test.tsx, test/push.test.tsx, test/background-sync.test.ts
```

---

### Task 1: Spike: what Expo Go allows (notifications, background task)

**Files:**
- Modify: `apps/mobile/package.json` (via `npx expo install expo-notifications expo-background-task expo-task-manager`)
- Create: `apps/mobile/test/__mocks__` entries or `test/setup.ts` mocks for the three modules
- Modify: this plan's Ruling 10 with the finding

**Interfaces:**
- Produces: jest mocks `expo-notifications` (`scheduleNotificationAsync`, `setNotificationHandler`, `addNotificationResponseReceivedListener`, `getPermissionsAsync`, `requestPermissionsAsync`, `dismissNotificationAsync`), `expo-background-task` (`registerTaskAsync`, `unregisterTaskAsync`, `getStatusAsync`, `BackgroundTaskStatus`), `expo-task-manager` (`defineTask`, `isTaskRegisteredAsync`), each a `jest.fn()` reset in `beforeEach`.

- [ ] **Step 1:** Install the three modules with `npx expo install` from `apps/mobile`; run `pnpm install` at the root.
- [ ] **Step 2:** Add the jest mocks to `test/setup.ts`; run `pnpm --filter mobile test`. Expected: all existing tests still pass.
- [ ] **Step 3:** On the emulator (Expo Go, `npx expo start --clear --localhost`, `adb reverse tcp:8081 tcp:8081`), a throwaway Demo tools button: (a) `requestPermissionsAsync()` then `scheduleNotificationAsync({ content: { title: 'Test', body: 'Local' }, trigger: null })`, and confirm a banner shows and a tap fires the response listener; (b) `getStatusAsync()` and `registerTaskAsync('tonnage-sync', { minimumInterval: 15 })`, then `adb shell cmd jobscheduler run -f host.exp.exponent <jobId>` (find the id with `adb shell dumpsys jobscheduler | grep -A3 host.exp.exponent`) and confirm the task body ran (console log in Metro).
- [ ] **Step 4:** Remove the throwaway button. Write the outcome (works / does not work, with the exact message) under Ruling 10, and note any Expo Go warning seen on import.
- [ ] **Step 5:** Commit `chore(mobile): add expo-notifications and background task modules (Expo Go spike)`.

### Task 2: Shared notification model, recipients, copy and links

**Files:**
- Create: `packages/shared/src/notifications/{kinds,recipients,render,links}.ts` + `*.test.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/rules/` untouched

**Interfaces:**
- Produces:
  - `NOTIFICATION_KINDS` (Ruling 2's eight) and `type NotificationKind`.
  - `notificationDataSchema: z.discriminatedUnion('kind', …)`; every variant carries `orderId?: string` and only kg/₹ integers and names. Fields per kind: dispatched `{ truckId, orderId, vehicleNo, netKg, partyName, companyName }`; over `{ orderId, subOrderId, subOrderNumber, partyName, overKg }`; created `{ orderId, orderNumber, actorName, partyName, orderedKg, companyCodes: string[] }`; aged `{ count, days, pendingKg }`; payment `{ brokerId, brokerName, paidRupees, dueRupees, mode, actorName }`; short closed `{ orderId, subOrderNumber, partyName, closedKg }`; assigned `{ truckId, orderId, vehicleNo, plannedKg, partyName, plantName }`; rejection `{ rejectionId, vehicleNo, code: ErrorCode }`.
  - `notificationSchema = { id, kind, data, deepLink, readAt: string|null, createdAt }`; `notificationPageSchema = { items, nextCursor: string|null }`; `unreadCountSchema = { count }`; `pushTokenBodySchema = { deviceId, token (1..200) }`.
  - `pushMessageSchema = { token, message: { type: 'alert', notification } | { type: 'sync', reason: 'tasks' } }`.
  - Types exported: `Notification`, `NotificationData`, `NotificationPage`, `PushMessage` (`z.infer` of the schemas above).
  - `recipientsFor(event: NotifyEvent, users: readonly RecipientUser[]): Recipient[]` where `NotifyEvent = { kind, actorId, plantIds: readonly string[], orderCreatorId? }` (the caller resolves company → plants), `RecipientUser = { id, role, active, plantIds }`, `Recipient = { userId, role, delivery: 'alert' | 'row-and-sync' }`. Also `NotificationContent` (kind + data), `SYNC_REJECT_REASON` (the app's `weightCodeMessage` reads it), `istTime(at)`.
  - `renderNotification(n: Pick<Notification,'kind'|'data'|'createdAt'>, basis: UnitBasis): { title: string; body: string }`; `tileFor(kind): { icon: string; tone: 'bl'|'vi'|'gr'|'am'|'rd' }`.
  - `deepLinkFor(kind, data, role): string`; `isAllowedDeepLink(path: string): boolean` (exact patterns: `/orders/<uuid>`, `/trucks/<uuid>`, `/parties/<uuid>`, `/orders?aged=1`, `/tasks`, `/attention`, `/notifications`).

- [ ] **Step 1: Failing tests** (`vitest`):
  - `recipients`: actor excluded (owner creates an order → owner not listed); a plant head of Siltara gets `order.created` only when a sub-order's company owns Siltara; `broker.payment_recorded` never lists `plant_head`/`supervisor`; inactive users excluded; `truck.assigned` gives supervisors `delivery: 'row-and-sync'`; city staff creator gets dispatched for their own order (another person dispatched it).
  - `render`: `truck.dispatched` with `netKg: 24180`, MT → title `CG 04 MK 2291 dispatched`, body `24.180 MT to Shubham Traders · Aarav · 10:48` (createdAt `2026-11-19T05:18:00Z`); same in kg → `24,180 kg to …`; aged `count: 1` → `1 order older than 10 days`, `count: 6` → `6 orders older than 10 days`; payment with `dueRupees: -5000` → body ends `Advance ₹5,000`; created → `Priya · Shubham Traders · 84.000 MT · AIP + KRM`.
  - `links`: `deepLinkFor('truck.assigned', d, 'supervisor') === '/tasks'`, `(…, 'plant_head') === '/trucks/<id>'`; `isAllowedDeepLink('/orders/019a…')` true; `'https://evil'`, `'/orders/../users'`, `'/users'`, `'//x'` false.
- [ ] **Step 2:** Run `pnpm --filter @tonnage/shared exec vitest run src/notifications`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the four files to the Interfaces above.
- [ ] **Step 4:** Run the same command. Expected: PASS. Run `pnpm --filter @tonnage/shared typecheck`.
- [ ] **Step 5:** Commit `feat(shared): notification kinds, recipients, copy and deep links`.

### Task 3: Mock notifications, push outbox and routes (contract first)

**Files:**
- Create: `packages/contract-tests/src/suites/notifications.contract.ts` (register it in `index.ts`)
- Create: `packages/mock-api/src/notifications.ts`, `packages/mock-api/src/handlers/notifications.ts`
- Modify: `packages/mock-api/src/store.ts` (`notifications`, `pushOutbox`, `devices`, `TenantRec.lastDigestDate`; built: backfilled in `parseSnapshot` instead of a `SNAPSHOT_VERSION` bump, so saved demo data survives), `pipeline.ts` (digest before, drain after commit), `controls.ts` (`onPush`), handlers at the Ruling 2 hook points (`orders.ts`, `trucks.ts`, `dispatch.ts`, `order-lifecycle.ts`, `brokers.ts`, rejection creation in `dispatch.ts`), hard delete in `order-lifecycle.ts`, `seed-orders.ts` (a few read and unread rows for the demo owner)

**Interfaces:**
- Consumes: Task 2 (`recipientsFor`, `deepLinkFor`, schemas).
- Produces:
  - `notify(state, ctx: { now: number; actor: Authed }, event: NotifyEvent & { dataFor(recipient): NotificationData }): void` — writes one row per recipient (+ one outbox `alert` row each, and `sync` rows for `row-and-sync`).
  - `queueSync(state, plantId, now)` — silent `sync` outbox rows for that plant's supervisors.
  - `drainOutbox(state): PushMessage[]` — marks rows sent; called by the pipeline only after the handler returned without throwing.
  - `MockControls.onPush(listener: (m: PushMessage) => void): () => void`.
  - Built: page cursor is plain `createdAt|id` (the mock runs in Hermes: no `Buffer`); `read` returns the notification, `read-all` returns `{ count: 0 }`, push-token routes return `{ deviceId }`; registering a token removes it from any other person (one token per phone); demo rows come from `seedDemoNotifications` replaying the rules over the seed.
  - Routes (Ruling 5, 7): `GET /v1/notifications`, `GET /v1/notifications/unread-count`, `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`, `POST /v1/notifications/push-token`, `DELETE /v1/notifications/push-token/:deviceId`; all `action: 'self.view'`.

- [ ] **Step 1: Failing contract tests** in `notifications.contract.ts`:
  - Priya creates an order with AIP + KRM sub-orders → Rajesh's list has one `order.created` (data `orderedKg` = total, `companyCodes: ['AIP','KRM']`, `deepLink: '/orders/<id>'`); Priya's list has none; Kiran (plant head, Siltara → AIP) has one whose `orderedKg` is the AIP part only.
  - An order with only Borai (KRM) sub-orders → Kiran gets nothing (**Review Focus 5**).
  - Record payment as Priya → Rajesh gets `broker.payment_recorded` with `paidRupees`; Kiran and Ravi get nothing (**Review Focus 5**).
  - Assign a truck at Siltara → Ravi's list has `truck.assigned` with `deepLink: '/tasks'` and no `*Rupees` key anywhere in `data`.
  - GROSS accepted → owner gets `truck.dispatched` with `netKg`; GROSS over tolerance → also `order.over_tolerance`.
  - A sync event refused (`TRUCK_CANCELLED`) → owner gets `rejection.created` → `deepLink: '/attention'`.
  - `unread-count` counts; `read` one → count −1; `read` again → 200, count unchanged; `read-all` → 0; another user's id → 404.
  - Pagination: 35 rows → first page 30 + `nextCursor`, second page 5; rows older than 30 days absent.
  - Hard delete of an order → its notifications gone from every list.
  - Rollback (**Review Focus 1**) lives in `packages/mock-api/src/notifications.test.ts`, following `pipeline.test.ts`: register a test route `{ transactional: true, action: 'order.create' }` whose handler calls `notify(...)` for Rajesh and then throws `new ApiError(409, 'STALE')` → the response is 409, Rajesh's `unread-count` is unchanged, and an `onPush` listener was called 0 times. A twin route that does not throw → one row and one push, delivered only after the response.
  - Daily digest: fake clock 08:59 IST, one aged order → no `orders.aged`; 09:00 → one for owner and each city staff, none for Kiran; a second request the same day → still one.
  - Push tokens: register `mock:dev-1` for Ravi; assign at Siltara → `onPush` receives `{ token: 'mock:dev-1', message: { type: 'sync' } }` and an `alert`; after `DELETE …/push-token/dev-1` → nothing for Ravi.
- [ ] **Step 2:** Run `pnpm --filter @tonnage/contract-tests exec vitest run -t "notifications"`. Expected: FAIL (404 routes).
- [ ] **Step 3:** Implement store fields, `notify`/`queueSync`/`drainOutbox`/digest in `notifications.ts`, the routes, the hook calls, the pipeline drain after commit, `onPush`, hard delete purge, seed rows. `data` per recipient is built from the recipient's scope (reuse `visibleSubOrders` with that recipient's `Authed`).
- [ ] **Step 4:** Run `pnpm --filter @tonnage/contract-tests test` and `pnpm --filter @tonnage/mock-api test`. Expected: PASS, including every earlier suite.
- [ ] **Step 5:** Commit `feat(mock-api): notifications, push outbox and push-token routes`.

### Task 4: App data layer: hooks and safe deep links

**Files:**
- Create: `apps/mobile/src/api/hooks/notifications.ts`, `apps/mobile/src/notifications/openLink.ts`
- Test: `apps/mobile/test/notifications.test.tsx` (hooks part)

**Interfaces:**
- Consumes: Task 3 routes; Task 2 schemas, `isAllowedDeepLink`.
- Produces:
  - `NOTIFICATIONS_KEY = ['notifications']`; `useNotifications()` (infinite, page cursor); `useUnreadCount()` (refetch on focus and every 60 s while signed in); `useMarkRead()`; `useMarkAllRead()` — both invalidate `NOTIFICATIONS_KEY`.
  - `openNotificationLink(router, deepLink: string): void` — `router.push(deepLink)` when `isAllowedDeepLink`, else `router.push('/notifications')`.
  - Sign-out and person switch clear `NOTIFICATIONS_KEY` (they are per user; follow the existing identity cache pattern in `hooks/cache.ts`).

- [ ] **Step 1: Failing tests:** owner on the seed → `useUnreadCount` returns the seeded unread count; `useMarkAllRead` → 0; `openNotificationLink(router, 'https://x')` pushes `/notifications`; `'/orders/<id>'` pushes that path.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/notifications.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): notification hooks and safe deep links`.

### Task 5: Notifications screen, Home bell, entry points

**Files:**
- Create: `apps/mobile/src/screens/notifications/{NotificationsScreen,NotificationRow,Bell}.tsx`, `apps/mobile/app/(app)/notifications.tsx`
- Modify: `apps/mobile/src/screens/home/HomeScreen.tsx` (bell in the top row, board 15), `apps/mobile/src/screens/ProfileScreen.tsx` (supervisor row "Notifications"), `apps/mobile/src/ui/Icon.tsx` (`bell`, `ban`)
- Test: `apps/mobile/test/notifications.test.tsx`

**Interfaces:**
- Consumes: Task 4 hooks, Task 2 `renderNotification`, `tileFor`.
- Produces: route `/notifications` (`RequireAction action="self.view"`); `<Bell />` with label `Notifications` / `Notifications, {n} new`.

- [ ] **Step 1: Failing tests:**
  - Screen shows `Today` / `Yesterday` / earlier date headers by IST date; rows show the Ruling 3 copy; unread rows have the dot and `accessibilityLabel` ending `, unread`.
  - Tap a row → `markRead` called and router pushed the deep link; tap "Mark all read" → no unread rows, the button is hidden.
  - Switching the unit basis to kg with the screen open → `24,180 kg to Shubham Traders …` with no new request to `/v1/notifications` (spy on the transport) (**Review Focus 4**).
  - Empty state: `No notifications yet` / `Orders, trucks and payments that need you show here.`
  - Home bell: label `Notifications, 3 new` on the seed; 12 unread → visible `9+`.
  - Supervisor Profile has a `Notifications` row that opens `/notifications`.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/notifications.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement to board 37 (header Back + "Mark all read", title, overline groups, `Group` of rows, 38 px tile, unread dot `br`). Pull to refresh.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): notifications list and Home bell (canvas 37, 15)`.

### Task 6: Push delivery: PushChannel, tokens, local notifications, silent sync

**Files:**
- Create: `apps/mobile/src/notifications/{pushChannel,usePush,permission,localNotify}.ts`
- Modify: `apps/mobile/app/(app)/_layout.tsx` (mount `usePush()`), `apps/mobile/src/auth/session.ts` (unregister before sign-out), `apps/mobile/src/api/demo.ts` (person switch re-registers), `apps/mobile/src/screens/SettingsScreen.tsx` + `ProfileScreen.tsx` (Notifications On/Off row, Ruling 8)
- Test: `apps/mobile/test/push.test.tsx`

**Interfaces:**
- Consumes: Task 3 `onPush` and push-token routes; Task 4 hooks; `requestSync()` from `src/offline/useSync.ts`.
- Produces:
  - `interface PushChannel { token(deviceId: string): Promise<string>; subscribe(onMessage: (m: PushMessage) => void): () => void }`; `getPushChannel(): Promise<PushChannel>` — mock: token `mock:{deviceId}`, subscribe = `controls.onPush` filtered to that token; http: token rejects with `PushUnavailable`, subscribe is a no-op (B4 fills it).
  - `usePush(): void` — on signed-in: register the token, subscribe; `alert` → `showLocal(notification)` + invalidate `NOTIFICATIONS_KEY`; `sync` → `requestSync()`; on unmount/sign-out: unsubscribe. Response listener → `markRead` + `openNotificationLink`.
  - `showLocal(n: Notification, basis: UnitBasis): Promise<void>` — `scheduleNotificationAsync({ content: { title, body, data: { id, deepLink } }, trigger: null })`.
  - `ensurePermission(): Promise<'granted'|'denied'>` — asks at most once per phone (flag in device prefs).

- [ ] **Step 1: Failing tests** (mock expo-notifications from Task 1):
  - Owner signed in; Priya's order created through the mock → `scheduleNotificationAsync` called once with title `New order SO-…`.
  - Supervisor Ravi signed in; owner assigns at Siltara via the mock transport → `requestSync` spy called, and no local notification for the `sync` message.
  - **Person switch:** Rajesh signed in, then `signInAsDemo(ravi)` → an order created by Priya produces no local notification (Rajesh's token was removed); an assignment at Siltara reaches Ravi (**Review Focus 2**).
  - Notification response with `data.deepLink: '/orders/<id>'` → router push + `POST …/read`; with `'https://x'` → `/notifications`.
  - Permission: `getPermissionsAsync` → undetermined → `requestPermissionsAsync` called once across two sign-ins; denied → Settings row reads `Off — open phone settings`, pressing calls `Linking.openSettings`.
  - Sign-out sends `DELETE /v1/notifications/push-token/<deviceId>`; with simulated Offline the sign-out still completes.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/push.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. `setNotificationHandler` once at module load of `localNotify.ts` (Ruling 9).
- [ ] **Step 4:** Run again, then `pnpm --filter mobile test`. Expected: PASS.
- [ ] **Step 5:** On the emulator: owner creates an order, switch to Kiran (plant head) → a banner shows; tap it → order detail. Screenshot for the PR.
  Built: `session.ts` gained `onSignOut(listener)`; the push goodbye (DELETE push-token) runs from it in the background with the old access token, so sign-out is never delayed. The mock also drops a phone's device row when its refresh session is signed out or revoked (`dropDevice`), so an offline sign-out still stops pushes. Supervisors receive both the `truck.assigned` alert and the silent `sync`.
  Emulator note: on one demo phone a banner only appears when *someone else* acts while you are signed in (the actor is never told), so Step 5's banner needs a second actor; jest covers the flow end to end.
- [ ] **Step 6:** Commit `feat(mobile): simulated push with local notifications and silent sync`.

### Task 7: Background sync for capture roles

**Files:**
- Create: `apps/mobile/src/offline/syncLock.ts`, `apps/mobile/src/offline/backgroundSync.ts`
- Modify: `apps/mobile/src/offline/useSync.ts` (loop runs inside `withSyncLock`; register/unregister the task), `apps/mobile/app/_layout.tsx` (import `backgroundSync.ts` at top level so `defineTask` runs at startup), `apps/mobile/src/screens/DemoToolsScreen.tsx` ("Run background sync now")
- Test: `apps/mobile/test/background-sync.test.ts`

**Interfaces:**
- Consumes: `startSyncLoop`, `engineFor`, `openDeviceStore`, `CAPTURE_ROLES`, `syncNow` (`useSync.ts`); Task 1 mocks.
- Produces:
  - `withSyncLock<T>(fn: () => Promise<T>): Promise<T>` — process-wide FIFO lock; the loop's `run()` and the task body both go through it.
  - `SYNC_TASK = 'tonnage-sync'`; `runBackgroundSync(): Promise<'synced' | 'skipped' | 'failed'>` — `skipped` when signed out or the role is not a capture role; uses `syncNow()` when a loop runs, else opens the store for the session's user, runs the engine once under the lock, closes the store; returns `BackgroundTaskResult.Success`/`Failed` to the OS.
  - `registerBackgroundSync(): Promise<boolean>` (false when `getStatusAsync()` is not `Available`); `unregisterBackgroundSync(): Promise<void>`.

- [ ] **Step 1: Failing tests:**
  - Capture role signs in → `registerTaskAsync('tonnage-sync', { minimumInterval: 15 })`; city staff → not registered; sign-out → `unregisterTaskAsync`.
  - Status `Restricted` → `registerBackgroundSync()` resolves `false`, nothing registered.
  - No loop running, one pending outbox row → `runBackgroundSync()` returns `synced`, the row is `accepted`, the store is closed afterwards.
  - **Overlap:** a loop run is in flight (push held on a deferred promise) when `runBackgroundSync()` starts → the second run waits; the mock receives the event once; final row `accepted` (**Review Focus 3**).
  - Signed out → `skipped`, no store opened.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/background-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again, then `pnpm --filter mobile exec jest test/sync-engine.test.ts test/supervisor.test.tsx`. Expected: PASS.
- [ ] **Step 5:** On the emulator as Ravi with simulated Offline, capture a tare, turn Offline off, press Home (app in background), force the job (Task 1 command) → Dispatch board as owner shows the tare. If Task 1 found tasks unavailable in Expo Go, use the Demo tools button instead and note it in the PR.
  Built: registration lives in `useBackgroundSync()` (mounted beside `useSync()`; no import cycle). `withSyncLock` waits at most `SYNC_LOCK_MAX_WAIT_MS` (2 min) for the run before it, so a hung run never stops the phone syncing; jest resets it per test (`test/setup-after-env.ts`). Verified the overlap test fails without the lock (the event is pushed twice).
- [ ] **Step 6:** Commit `feat(mobile): background sync for supervisors with a shared sync lock`.

### Task 8: Graphite dark polish

**Files:**
- Modify: `apps/mobile/src/theme/tokens.ts` (Ruling 12 tokens, `unitBarColor`), `apps/mobile/src/ui/{Sheet,Switch,Toast,SegmentedControl,Button,TabBar,layout,TextField,SearchField}.tsx`, `apps/mobile/src/screens/home/HomeScreen.tsx` (bar colours), `apps/mobile/src/screens/new-order/WizardScreen.tsx:406` (`#888` → `t.tx3`), every `TextInput` (`placeholderTextColor={t.tx3}`, `selectionColor={t.br}`, `keyboardAppearance={scheme}`), `RefreshControl` colours, `eslint.config.mjs` (the app is edge-to-edge since SDK 54, so the system bars need no colour; `app.json` is unchanged)
- Test: `apps/mobile/test/dark-theme.test.tsx`

**Interfaces:**
- Produces: tokens `tabBar, scrim, shadow, onDanger, thumb, highlight`; `unitBarColor(slot: number, scheme: ColorScheme): string`; `collectColors(tree): Set<string>` test helper in `test/a11y/audit.ts` (shared with Task 10).

- [ ] **Step 1: Failing tests:**
  - ESLint: add a `no-restricted-syntax` rule for string literals matching `/^#[0-9a-f]{3,8}$|^rgba?\(/i` in `apps/mobile/src/**` and `app/**`, except `src/theme/tokens.ts`; `pnpm lint` fails on the six current literals.
  - `dark-theme.test.tsx`: render Home, Orders, Order detail, Dispatch, More, Notifications, Supervisor Tasks, Capture, Create sheet, Record payment sheet with the theme forced to dark; `collectColors` over every `style` color/backgroundColor/borderColor/shadowColor and every `color` prop → each value is in `Object.values(darkTokens)` ∪ dark `unitTagColors` ∪ `unitBarColor(*, 'dark')` ∪ `{'transparent'}`. Same matrix in light against light values.
- [ ] **Step 2:** Run `pnpm lint` and `pnpm --filter mobile exec jest test/dark-theme.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Add tokens, replace literals, apply board 15 (tab bar `tabBar`, group `highlight` top border in dark, scrim `scrim`), thread `keyboardAppearance`/`placeholderTextColor`/`selectionColor`.
- [ ] **Step 4:** Run both again. Expected: PASS.
- [ ] **Step 5:** Emulator sweep in dark (Settings → Appearance → Dark): Home, Orders, Order detail, New order steps 1–3, Assign vehicle, Dispatch, Truck detail, More, Broker ledger, Record payment, Reports, Settings, Notifications, Create sheet, Calendar sheet, Unit switcher, Supervisor Tasks, Capture tare/gross, Keypad, Done today, Needs attention, Demo tools, Lock screen. Fix anything unreadable; screenshots of Home dark vs board 15 in the PR.
  Built: tokens `tabBar, scrim, shadow, onDanger, thumb` (the 4 % `highlight` was dropped: invisible beside the 6 % border); `unitBarColor` for Home's bar; `inputTheme(t, scheme)` gives every TextInput its placeholder, cursor/selection and keyboard colours; lint rule `no-restricted-syntax` on colour literals. The colour test was checked to catch a stray colour. The emulator sweep (Step 5) waits for Metro, which was stopped for low memory.
- [ ] **Step 6:** Commit `feat(mobile): Graphite dark polish and no raw colours`.

### Task 9: Token contrast check

**Files:**
- Create: `apps/mobile/src/theme/contrast.ts`, `apps/mobile/test/contrast.test.ts`
- Modify: `apps/mobile/src/theme/tokens.ts` (only pairs that fail, Ruling 13)

**Interfaces:**
- Produces: `contrastRatio(fg: string, bg: string): number` (WCAG 2.1 relative luminance; `rgba` blended over `bg`); `TEXT_PAIRS: { fg: keyof Tokens; bg: keyof Tokens; min: 4.5 | 3 }[]`.

- [ ] **Step 1: Failing test:** `contrastRatio('#000000', '#FFFFFF') ≈ 21`, `('#767676', '#FFFFFF') ≥ 4.5`; for both themes every `TEXT_PAIRS` entry meets its `min`: `tx/tx2/tx3` on `bg`, `card`, `ctl`; `brt` on `brs`+`card`; `okt` on `oks`+`card`; `wnt` on `wns`+`card`; `dgt` on `dgs`+`card`; `vi` on `vis`+`card`; `te` on `tes`+`card`; `invtx` on `inv`; `onDanger` on `dgf`; `invtx2` on `inv`; unit tag fg on its bg for slots 0–3.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/contrast.test.ts`. Expected: FAIL (helper missing), then failures name any pair below threshold.
- [ ] **Step 3:** Implement `contrast.ts`; adjust failing text tokens per Ruling 13 with a comment `// was #xxxxxx (canvas), raised for 4.5:1 on <bg>`.
- [ ] **Step 4:** Run again plus `test/theme.test.tsx`. Expected: PASS.
  Built — three canvas pairs failed and were moved per Ruling 13: dark `inv` #4F86F7 → #4473D4 (white text 3.45 → 4.52; primary buttons, New tab, lead tile); `invtx2` light .8 → .92 alpha (3.89 → 4.65); dark `invtx2` → #FFFFFF (only full white passes on the dark fill). Every other text pair, the unit tags and icon colours already passed.
- [ ] **Step 5:** Commit `test(mobile): token contrast checks in both themes`.

### Task 10: Accessibility audit across screens

**Files:**
- Create: `apps/mobile/test/a11y/audit.ts`, `apps/mobile/test/a11y.test.tsx`
- Modify: UI primitives and screens the audit flags

**Interfaces:**
- Consumes: the screen render helpers already in tests (seeded mock, providers).
- Produces: `auditA11y(root): A11yIssue[]` with `A11yIssue = { rule: 'name' | 'role' | 'target' | 'icon-hidden' | 'header' | 'state'; path: string; detail: string }`. Rules: every host node with `onPress`/`onLongPress` has `accessibilityRole` and a non-empty name (label or text content); explicit `width`/`height`/`minHeight` below 44 on a pressable without `hitSlop` making up 44 → `target`; `Icon` inside a named pressable is `accessible={false}`; each screen has exactly one `accessibilityRole="header"` page title; `Switch`/`Choice`/tabs expose `checked`/`selected`; `ProgressBar` has `accessibilityValue {min,max,now}`; `Badge` text is not empty (status not colour only).

- [ ] **Step 1: Failing tests:** `auditA11y` unit tests on tiny trees (an unlabeled icon button → `name`; a 32 px pressable without hitSlop → `target`); then the screen matrix (owner: Home, Orders, Order detail, Order form step 1, Dispatch, Truck detail, Assign vehicle, More, Parties, Party detail, Broker ledger, Reports, Settings, Users, Companies, Notifications, Create sheet, Loading picker; supervisor: Tasks, Capture, Done today, Profile; auth: Sign in, Verify, Lock) → `expect(auditA11y(screen.root)).toEqual([])`.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/a11y.test.tsx`. Expected: FAIL with the list of issues.
- [ ] **Step 3:** Fix each issue at its source (prefer fixing the primitive in `src/ui/` over the screen).
- [ ] **Step 4:** Run again and `pnpm --filter mobile test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(mobile): accessibility audit clean on every screen`.

### Task 11: Live regions, reduced motion, large text, TalkBack pass

**Files:**
- Modify: `apps/mobile/src/ui/Keypad.tsx` (`WeightReadout` live region), `apps/mobile/src/screens/supervisor/` sync banner, `apps/mobile/src/ui/Toast.tsx` (`AccessibilityInfo.announceForAccessibility`), `apps/mobile/src/ui/Sheet.tsx` (+ `CalendarSheet`, `ConfirmSheet`: `animationType` `fade` when reduce motion), `apps/mobile/src/a11y/useReduceMotion.ts` (new)
- Test: `apps/mobile/test/a11y.test.tsx` (additions)

**Interfaces:**
- Produces: `useReduceMotion(): boolean` (`AccessibilityInfo.isReduceMotionEnabled` + `reduceMotionChanged` listener).

- [ ] **Step 1: Failing tests:** `WeightReadout` has `accessibilityLiveRegion="polite"` and a label `Gross weight, 36,420 kilograms` style read-out (unit spoken in words); the supervisor sync banner is a polite live region; `showToast('Saved')` calls `announceForAccessibility('Saved')`; with reduce motion on, `Sheet`'s `Modal` has `animationType="fade"`.
- [ ] **Step 2:** Run `pnpm --filter mobile exec jest test/a11y.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Manual large-text sweep** on the emulator: `adb shell settings put system font_scale 1.3`, then `2.0`, plus app Text size Large, over the Task 8 screen list; fix clipping (allow wrap, keep numbers on one line with `numberOfLines` only where the canvas does). Reset with `font_scale 1.0`.
- [ ] **Step 6: Manual TalkBack pass** (if the emulator image has Android Accessibility Suite): sign in, create an order, assign, capture tare and gross as Ravi, open a notification. Every control is reachable by swipe, named, and in visual order. Note findings in the PR; fix blockers.
  Built: the readout ("36.64 tonnes"), sync banner and toast announcements already existed from F3/F4 and are now pinned by tests; new `useReduceMotion()` makes `Sheet` (so Calendar and Confirm sheets too) and the report rows sheet fade instead of slide. Steps 5–6 (font scale 1.3 / 2.0 sweep, TalkBack pass) are manual on the emulator and wait for Metro (stopped for low memory).
- [ ] **Step 7:** Commit `feat(mobile): live regions, reduced motion and large text fixes`.

### Task 12: Docs and final verification

**Files:**
- Modify: `CLAUDE.md` (F5 done; notifications model, PushChannel, background sync and lock, Expo Go limits, dark tokens and the lint rule, a11y audit), this plan (Task 1 finding already in Ruling 10)

- [ ] **Step 1:** Update CLAUDE.md: "Done" line adds F5; new bullets under Architecture for Notifications (F5), Push (F5), Background sync (F5), Dark theme and accessibility (F5); Mobile layout adds `src/notifications/`, `src/screens/notifications/`, `test/a11y/`.
- [ ] **Step 2:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test` at the root. Expected: all pass (the contract suite includes `notifications`).
- [ ] **Step 3:** Commit `docs: CLAUDE.md for F5`.
