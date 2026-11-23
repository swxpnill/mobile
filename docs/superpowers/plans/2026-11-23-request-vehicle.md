# Request Vehicle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff ask the broker or customer for a truck from the app: pick the person and number, the material and the MT, then call or WhatsApp with a prefilled message. The request is recorded, and an amber note shows on the order until a truck arrives for those lines.

**Architecture:** Pure rules live in `packages/shared/src/rules/vehicleRequest.ts`: the default recipient, clamping MT to pending, the message builder and the open/closed state of a request. The mock adds `POST /v1/orders/:id/vehicle-requests` (idempotent, transactional). It writes an `order.vehicle_requested` activity, and the order detail carries `vehicleRequests` (open ones only, money-free). The app adds `RequestVehicleSheet` (built on `src/ui/Sheet.tsx`), opened from order detail and from the Dispatch board through the existing loading picker in a request mode. Call and WhatsApp use `Linking`. The record is sent through the API client, with a small per-person queue for offline.

**Tech Stack:** Expo Router, TanStack Query, zod, `react-native` `Linking`, `expo-clipboard` (ships in Expo Go), jest + RNTL, vitest.

**Spec:** the Notion card "Request vehicle" (the brief) and canvas boards `RequestVehicle.dc.html` (40), `OrderDetail.dc.html` (04) and `Dispatch.dc.html` (08) on https://claude.ai/artifact/1cf17fda-d3a4-498b-b46d-c67fdc49f795. Rules: CLAUDE.md and `docs/superpowers/specs/2026-11-04-tonnage-design.md`.

## Global Constraints

- Expo Go only: no custom native modules. `expo-clipboard` is added with `npx expo install expo-clipboard`, then Metro is restarted with `--clear`.
- Permission `truck.assign` (owner, city staff) gates every entry point and the route. Plant roles never see the button and get 403 from the route.
- Quantities are integer kg everywhere: stored, sent, and inside rules. MT is display and input only, through `toDisplayQty` / `parseQtyInput`. No floats.
- The order's status does not change. A request writes no truck, no ledger row and no notification.
- Colours only from `src/theme/tokens.ts` (lint enforces it). WhatsApp green is a new token `wa` (light `#128C4A`, dark `#1FA855`, as on the canvas). It must pass `test/contrast.test.ts` as white-on-`wa`.
- Touch targets ≥ 44 dp. Every control passes `test/a11y/audit.ts`. Radios and checkboxes carry `accessibilityRole` and `accessibilityState`.
- Copy is from the canvas, word for word: "Request vehicle", "Send to", "Material", "All pending", "One company", "Pick lines", "Total to request", "Message · you can edit", "Copy", "Call", "Send on WhatsApp", "call only", "No number saved", and the note "Vehicle requested · {total} · {products}" / "{contact} · {Call|WhatsApp} · {time}".
- Any behaviour change starts with a contract test (`packages/contract-tests`).
- Branch `feat/request-vehicle` from `main`. Conventional Commits with scope.

## Rulings (decided while planning; gaps in the brief)

1. **Unit in the message.** The text goes to an outside party, so it uses the tenant's `externalUnitBasis` (default `mt`), not the viewer's unit basis. MT inputs in the sheet follow the viewer's basis, like every other input.
2. **`{plant}`.** Sub-orders carry no plant. Use the company's plant when it has exactly one active plant; otherwise leave the plant out: "({company})". The order detail already lists companies; plants come from `useCompanies`/`usePlants`.
3. **`{name}`.** The contact's first name plus " ji". `{party}` is the customer's name, or the broker's for a broker-only order. `{sender}` is the signed-in person's first name.
4. **When a request is open.** A request stays open until a truck is assigned, after the request time, to at least one of its lines' sub-orders (the vehicle came). Short close, cancel or a fully dispatched sub-order also close it. Only open requests are returned in `Order.vehicleRequests`. The newest open one shows the note; older open ones are listed as "+N earlier" under it.
5. **Offline.** Call and WhatsApp open regardless. The record goes through `useRequestVehicle`. On a network error it is saved to a per-person AsyncStorage queue (`tonnage-vehicle-requests-<userId>`) with its Idempotency-Key, and sent on the next app foreground or the next successful request. The note shows at once from the optimistic cache, marked "· waiting to send".
6. **Numbers.** A number that does not normalise to an Indian mobile (`normalizeMobile`) is "call only" whatever its `whatsapp` flag says, so wa.me is never built from a landline. A tel: link is built for any saved number.
7. **Dispatch board.** It gets the two floating buttons from canvas 08. "Assign vehicle" goes to `/pick-loading` (today's flow). "Request vehicle" goes to `/pick-loading?mode=request`. The picker groups by order, lists only orders with pending > 0, and on tap opens the sheet for that order.
8. **When is the record sent?** On tapping Call or Send on WhatsApp, after `Linking.canOpenURL` resolves true and just before `openURL`. If WhatsApp is not installed, the toast says "WhatsApp isn't installed" and nothing is recorded.
9. **Route shape.** `POST /v1/orders/:id/vehicle-requests`, action `truck.assign`, `idempotent: true`, `transactional: true`. Body `vehicleRequestBodySchema`; response `{ request: VehicleRequest }` with status 201. Lines must belong to the order and be open, with `0 < kg ≤ pending` (otherwise 422 VALIDATION at `lines.N.kg`). `totalKg` must equal Σ kg (422 at `totalKg`). `partyId` must be the order's customer or broker (422 at `partyId`). An order out of scope gives 404.

## Review Focus

1. **The person edited the message, then changed the material:** their text must not be overwritten. Show a small "Update message" link instead. → Task 4 test.
2. **The selected number is a landline or has `whatsapp: false`:** the WhatsApp button is disabled with "call only", and Call still works. → Task 1 rule test + Task 4 test.
3. **A viewer on the kg basis:** inputs and pending show kg, and the message still shows MT per `externalUnitBasis`. → Task 1 + Task 4 tests.
4. **MT typed above pending, negative, blank, or with more than 3 decimals:** clamped to [0, pending]. A line left at 0 is unticked. Total 0 disables both actions. → Task 1 + Task 4 tests.
5. **An order whose lines are all dispatched while the sheet is open (refetch):** the sheet shows "Nothing pending on this order" and both actions are disabled. A request already sent shows 422 VALIDATION as a toast. → Task 2 contract + Task 4 test.

---

### Task 1: Shared rules and schemas

**Files:**
- Create: `packages/shared/src/rules/vehicleRequest.ts`, `packages/shared/src/rules/vehicleRequest.test.ts`
- Modify: `packages/shared/src/schemas/orders.ts` (schemas below; `orderSchema` gains `vehicleRequests`), `packages/shared/src/index.ts` (exports)

**Interfaces:**
- Produces:
  - `vehicleRequestChannelSchema = z.enum(['call','whatsapp'])`
  - `vehicleRequestBodySchema = z.object({ partyId: idSchema, contactName: nameSchema, number: phoneSchema, channel, lines: z.array(z.object({ orderLineId: idSchema, kg: z.number().int().positive() })).min(1).max(50), totalKg: z.number().int().positive() }).strict()`
  - `vehicleRequestSchema = z.object({ id, partyId, partyName, contactName, number, channel, lines: [{ orderLineId, subOrderId, kg }], totalKg, requestedAt, requestedBy: { id, name } }).strict()`, with `orderSchema.vehicleRequests: z.array(vehicleRequestSchema)` (no money keys).
  - `type Recipient = { partyId: string; contactId: string; numberId: string }`
  - `defaultRecipient(order: { broker: PartyRef | null; customer: PartyRef | null }, parties: Record<string, PartyDetail>): Recipient | null`: the broker's first WhatsApp-capable number (per `isWhatsAppNumber`), else the customer's, else the first number of the broker, else of the customer, else null.
  - `isWhatsAppNumber(n: { number: string; whatsapp: boolean }): boolean`: `whatsapp && normalizeMobile(number) !== null` (Ruling 6).
  - `clampLineKg(kg: number, pendingKg: number): number`: returns an integer in [0, pendingKg].
  - `buildRequestMessage(input: { contactFirstName; orderNo; party; lines: { product: string; size: string; length: string; kg: number; company: string; plant: string | null }[]; senderFirstName; basis: UnitBasis }): string`: the canvas template exactly. A line with no plant drops ", {plant}". Quantities go through `toDisplayQty(kg, basis)` plus `unitLabel(basis)`.
  - `isRequestOpen(req, ctx: { trucks: { subOrderIds; assignedAt }[]; subOrderClosed: (id) => boolean; linePendingKg: (id) => number }): boolean` (Ruling 4).

- [ ] **Step 1: Write the failing tests** in `vehicleRequest.test.ts`:

```ts
expect(defaultRecipient(withBrokerWa, parties)).toEqual({ partyId: BROKER, contactId: RK, numberId: RK_WA });
expect(defaultRecipient(brokerLandlineOnly, parties)?.partyId).toBe(CUSTOMER);       // customer has WhatsApp
expect(defaultRecipient(customerOnly, parties)?.partyId).toBe(CUSTOMER);
expect(defaultRecipient(noNumbers, parties)).toBeNull();
expect(isWhatsAppNumber({ number: '+917714042210', whatsapp: true })).toBe(false);   // landline
expect([clampLineKg(30_001, 30_000), clampLineKg(-5, 30_000), clampLineKg(12_500, 30_000)]).toEqual([30_000, 0, 12_500]);
expect(buildRequestMessage(canvasExample)).toBe(
  'Namaste R.K. ji, please arrange a vehicle for order SO-2611-0142 (Shubham Traders, Nagpur):\n' +
  '• TMT Fe500D 12 mm · 12 m — 24.000 MT (Aarav, Siltara)\n' +
  '• TMT Fe500D 16 mm · 12 m — 30.000 MT (Kalinga, Borai)\n' +
  'Total 54.000 MT. Please share vehicle number and driver phone.\n– Rajesh, Tonnage');
expect(buildRequestMessage({ ...canvasExample, basis: 'kg' })).toContain('24,000 kg');
expect(isRequestOpen(req, { trucks: [{ subOrderIds: [SO_A], assignedAt: AFTER }], ...ctx })).toBe(false);
expect(isRequestOpen(req, { trucks: [{ subOrderIds: [SO_A], assignedAt: BEFORE }], ...ctx })).toBe(true);
// plus a schema test: vehicleRequestSchema has no key in MONEY_KEYS
```

- [ ] **Step 2: Run them to make sure they fail.** `pnpm --filter @tonnage/shared exec vitest run src/rules/vehicleRequest.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the rules and schemas.
- [ ] **Step 4: Run them to make sure they pass**, then run `pnpm --filter @tonnage/shared test`.
- [ ] **Step 5: Commit.** `feat(shared): vehicle request rules and schemas`

---

### Task 2: Contract and mock API

**Files:**
- Create: `packages/contract-tests/src/suites/vehicle-requests.contract.ts` (register it in `index.ts`'s `CONTRACT_SUITES` after `lifecycle`)
- Create: `packages/mock-api/src/handlers/vehicle-requests.ts`
- Modify: `packages/mock-api/src/store.ts` (`MockState.vehicleRequests: VehicleRequestRec[]`, bumping the store version with a migration that starts the list empty), `packages/mock-api/src/order-views.ts` (fill `vehicleRequests` with open requests via `isRequestOpen`), `packages/mock-api/src/handlers/order-lifecycle.ts` (hard delete purges the order's requests), `packages/mock-api/src/index.ts` (`ALL_ROUTES`), `packages/mock-api/src/seed-orders.ts` (one open request on the demo order SO-2611-0141 from its broker, so the note shows after Reset demo data)

**Interfaces:**
- Consumes: Task 1 schemas and `isRequestOpen`.
- Produces: `POST /v1/orders/:id/vehicle-requests` (Ruling 9) → `201 { request: VehicleRequest }`. Activity `order.vehicle_requested` with meta `{ contactName, channel, totalKg, partyName }`.

- [ ] **Step 1: Write the contract suite.** Each case is one `it`:
  - Owner posts → 201. The order detail then has one `vehicleRequests` entry, and its `status` is unchanged.
  - A replay with the same Idempotency-Key gives the same body and writes one activity row.
  - City staff → 201. A supervisor → 403. A plant head → 403.
  - kg above pending → 422 at `['lines', 0, 'kg']`. A line from another order → 422 at `['lines', 0, 'orderLineId']`.
  - `totalKg` ≠ Σ → 422 at `['totalKg']`. A `partyId` that is not on the order → 422 at `['partyId']`.
  - Another tenant's order → 404.
  - After a truck is assigned to that sub-order (`POST /v1/trucks` flow), `vehicleRequests` is `[]`.
  - Short close of the sub-order clears it.
  - `GET /v1/orders/:id/activity` contains `order.vehicle_requested` with meta.
  - Hard delete leaves no request.
- [ ] **Step 2: Run them to make sure they fail.** `pnpm --filter @tonnage/contract-tests exec vitest run -t "vehicle request"` → FAIL (404, no route).
- [ ] **Step 3: Implement** the handler, the store migration, the view and the seed.
- [ ] **Step 4: Run them to make sure they pass**, then the whole contract and mock suites: `pnpm --filter @tonnage/contract-tests test && pnpm --filter @tonnage/mock-api test`. The F1–F5 suites stay green.
- [ ] **Step 5: Commit.** `feat(mock-api): record vehicle requests on an order`

---

### Task 3: App data layer: mutation, offline queue, links, clipboard

**Files:**
- Create: `apps/mobile/src/api/hooks/vehicleRequests.ts`, `apps/mobile/src/offline/vehicleRequestQueue.ts`
- Modify: `apps/mobile/src/format/contactLinks.ts` (reuse `telLink` / `whatsappLink`; add `whatsappLink` test cases for encoding), `apps/mobile/package.json` (`expo-clipboard` via `npx expo install`), `apps/mobile/src/theme/tokens.ts` (token `wa`)
- Test: `apps/mobile/test/vehicleRequests.test.tsx`, `apps/mobile/test/contactLinks.test.ts`

**Interfaces:**
- Produces:
  - `useRequestVehicle(orderId: string): { send(body: VehicleRequestBody): Promise<'sent' | 'queued'> }`. It holds one Idempotency-Key per send (`submitKey.ts`), optimistically adds the request to the order query cache, invalidates order, orders and activity on success, and on a `NetworkError` enqueues and returns `'queued'`.
  - `enqueueVehicleRequest(userId, item)`, `flushVehicleRequests(userId, send): Promise<number>`. FIFO; an item leaves the queue only on a 2xx, or on a 4xx that would never succeed (422/404/403), which shows a toast "Couldn't record the vehicle request: {message}". It is flushed on AppState `active` and after any successful send. The person-switch `freshStart` and sign-out keep the queue per userId, so nothing leaks to another person.

- [ ] **Step 1: Write the failing tests.**
  - `whatsappLink('+919926830011', 'Namaste R.K. ji,\n• 12 mm — 24.000 MT & more')` equals `https://wa.me/919926830011?text=` plus `encodeURIComponent` of the text. Newlines become `%0A` and `&` becomes `%26`.
  - The hook against the in-process mock: `send` gives `'sent'` and the order cache holds the request.
  - With demo Offline on, `send` gives `'queued'`. After turning Offline off and flushing, the activity holds exactly one entry, and the same key is reused.
  - A queued item that comes back 422 is dropped with a toast.
- [ ] **Step 2: Run them to make sure they fail.** `pnpm --filter mobile exec jest test/vehicleRequests.test.tsx test/contactLinks.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to make sure they pass.** Also run `pnpm --filter mobile exec jest test/contrast.test.ts test/dark-theme.test.tsx`, since there is a new token.
- [ ] **Step 5: Commit.** `feat(mobile): vehicle request mutation with offline queue`

---

### Task 4: Request vehicle sheet (canvas 40)

**Files:**
- Create: `apps/mobile/src/screens/orders/RequestVehicleSheet.tsx`, `apps/mobile/src/screens/orders/requestVehicleState.ts` (pure reducer: recipient, material mode, per-line selection and kg, message and `messageEdited`)
- Test: `apps/mobile/test/request-vehicle.test.tsx`, `apps/mobile/test/requestVehicleState.test.ts`

**Interfaces:**
- Consumes: Task 1 rules, Task 3 hook, `useParty`, `useMe`, `useSettings` (`externalUnitBasis`), the unit switcher's `useUnitBasis`, `Sheet`, `SegmentedControl`, `TextField`, `Button`, `showToast`.
- Produces: `RequestVehicleSheet({ order, visible, onClose, prefill?: VehicleRequest })`. `prefill` restores the party, number, lines and kg from an open request, and the message is rebuilt.

Layout follows `RequestVehicle.dc.html` exactly:
- Header: "Request vehicle", with `{orderNo} · {party}` underneath and a close icon button.
- **Send to:**
  - A segmented control with one segment per party the order has. Each shows the name, with "Broker" in the `vi` tone or "Customer" underneath. With one party the control is hidden and its name shows as a row.
  - A radio list of that party's contact numbers: name · label, the number, and a WhatsApp tag or "call only".
  - When a party has no numbers: "No number saved" with a link "Add a number" → `/parties/form?id=…`.
- **Material:** a segmented control:
  - All pending (shows the total);
  - One company (shows the company codes; reveals a radio list of open sub-orders, each with its pending quantity);
  - Pick lines: rows with a checkbox, the unit tag, `product · size · length`, "{pending} pending", and a qty field in the viewer's basis.
  - A "Total to request" row in the `brs`/`brt` tones.
- **Message:** the "Message · you can edit" overline with a Copy text button and a multiline field. The text is rebuilt on any change while `messageEdited` is false. Once edited, a change shows "Update message" in the overline row.
- **Footer:**
  - [Call] secondary.
  - [Send on WhatsApp] filled with token `wa`, with white text and a chat icon. Disabled when the number is not WhatsApp-capable or the total is 0.

- [ ] **Step 1: Write the failing tests.**
  - **Reducer:** the default material is All pending, with every open line at its pending. Switching to Pick lines keeps those kg. Typing "35" on a 30 MT line clamps it to 30,000 kg. An empty field gives 0 and unticks the line. Any change after `messageEdited` leaves `message` unchanged and sets `messageStale`.
  - **Screen tests (RNTL, mock API, Rajesh):**
    - On the seeded broker order, R.K. Agarwal's WhatsApp number is preselected.
    - On a customer-only order, the customer's number is preselected and there is no segmented control.
    - Picking the landline disables "Send on WhatsApp" and shows "call only".
    - Tapping Send on WhatsApp calls `Linking.openURL` with a wa.me URL that has the encoded message (spy) and records one request.
    - Call calls `Linking.openURL('tel:+91…')` and records the `call` channel.
    - Copy calls `Clipboard.setStringAsync` with the message and shows the toast "Copied".
    - On the kg basis, the inputs show kg and the message shows MT.
    - Review Focus 5: with every line dispatched, the sheet shows "Nothing pending on this order" and both actions are disabled.
    - The a11y audit passes on the open sheet, in light and dark.
- [ ] **Step 2: Run them to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to make sure they pass.**
- [ ] **Step 5: Commit.** `feat(mobile): request vehicle sheet`

---

### Task 5: Order detail entry, note and activity copy (canvas 04)

**Files:**
- Modify: `apps/mobile/src/screens/orders/OrderDetailScreen.tsx` (footer and sheet wiring), `apps/mobile/src/screens/orders/OrderTrucks.tsx` (amber note), `apps/mobile/src/screens/orders/ActivitySheet.tsx` (`order.vehicle_requested` copy)
- Test: extend `apps/mobile/test/order-detail.test.tsx` (or the existing order detail test file)

**Interfaces:**
- Consumes: Task 4 `RequestVehicleSheet`, `Order.vehicleRequests`.

Footer per canvas 04:
- [Request vehicle] secondary with a chat icon and [Assign vehicle] primary, equal width (`flex: 1` each).
- Shown when `may('truck.assign')` and the order has pending > 0 on an open sub-order.
- "Short close" leaves the footer; it stays in the ⋯ sheet, where it already is.
- Assign keeps today's behaviour: direct with one sub-order, otherwise the actions sheet.

Note at the top of Trucks:
- Shown for the newest open request.
- A `wns` background with `wnt` text and a chat icon.
- Text: "Vehicle requested · {total} · {product sizes}" and "{contact} · {Call|WhatsApp} · {HH:mm IST}".
- Queued requests show "· waiting to send".
- Tapping it opens the sheet prefilled.
- Older open requests show as "+N earlier".

Activity copy: "Vehicle requested from {contact} via {Call|WhatsApp} · {total}".

- [ ] **Step 1: Write the failing tests.**
  - The owner sees both footer buttons. A plant head sees neither.
  - A fully dispatched order hides Request vehicle.
  - The seeded request shows its note. Tapping the note opens the sheet with its lines.
  - After assigning a truck to that sub-order, the note is gone.
  - The activity sheet shows the request entry.
  - Short close is no longer in the footer but is still in the ⋯ sheet.
- [ ] **Step 2: Run them to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to make sure they pass.**
- [ ] **Step 5: Commit.** `feat(mobile): request vehicle on order detail with requested note`

---

### Task 6: Dispatch board buttons and picker request mode (canvas 08)

**Files:**
- Modify: `apps/mobile/src/screens/dispatch/DispatchScreen.tsx` (floating buttons, `truck.assign` only), `apps/mobile/src/screens/create/LoadingPickerScreen.tsx` (`mode` param), `apps/mobile/app/(app)/pick-loading.tsx` (passes the param)
- Test: extend `apps/mobile/test/dispatch.test.tsx` and `apps/mobile/test/loading-picker.test.tsx` (or the existing files for those screens)

**Interfaces:**
- Floating row, bottom right, above the tab bar: white "Request vehicle" (`card` background, `bd2` ring, shadow) then blue "Assign vehicle" (`inv`). Each is 52 dp high with a 16 radius. Assign goes to `/pick-loading`. Request goes to `/pick-loading?mode=request`.
- With `mode=request` the picker:
  - titles itself "Request vehicle · pick an order";
  - lists orders with pending > 0 (one row per order, its sub-order tags inline);
  - opens `RequestVehicleSheet` for the tapped order, fetched with `useOrder`.
  - The default mode is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - The owner sees both floating buttons. A supervisor and a plant head see none.
  - Request opens the picker in request mode. Tapping SO-2611-0141 opens the sheet for it.
  - Orders with nothing pending are not listed.
  - Assign still opens the sub-order picker.
- [ ] **Step 2: Run them to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to make sure they pass.**
- [ ] **Step 5: Commit.** `feat(mobile): request vehicle from the dispatch board`

---

### Task 7: Docs, full verification, emulator walkthrough

**Files:** `CLAUDE.md` (one bullet under Architecture: route, open/closed rule, externalUnitBasis message, offline queue, entry points), `README.md` only if the demo steps mention the board.

- [ ] **Step 1: Run everything.** `pnpm lint && pnpm typecheck && pnpm test` → all green.
- [ ] **Step 2: Emulator walkthrough** (mock mode, Rajesh), light and dark:
  - Order detail → Request vehicle. WhatsApp opens with the message, or shows the "WhatsApp isn't installed" toast on a bare emulator.
  - The note appears. Assign a truck and the note clears.
  - Dispatch board → Request vehicle → pick order → sheet.
  - Demo tools Offline → request → note "waiting to send" → Offline off → the note settles.
  - Record screenshots in the PR description.
- [ ] **Step 3: Commit.** `docs: request vehicle in CLAUDE.md`
