# F2 Masters & Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner and city staff manage customers, brokers, transporters and products, book multi-company orders in a 3-step wizard (with server-side drafts), and run the order lifecycle (edit within role limits, move quantity, short close incl. open trucks, cancel, reopen, hard delete); everyone sees a live Home and Orders list filtered by the unit switcher, in their own unit basis, with money hidden from plant heads. All against the mock API, proven by the contract suite.

**Architecture:** Business rules are pure functions in `packages/shared/src/rules/` (pricing, quantities, status, numbering, edits), used by the mock now and the B2 API later, and by the app for previews. `packages/mock-api` gains masters + orders routes over a v2 store; the contract suite gains `masters` and `orders` suites. Trucks do not exist until F3, so the store carries a minimal `TruckRec` that only contract fixtures (and the demo seed) create, so dispatched/reserved quantities and open-truck short close are real today. The app adds a unit-filter store, money/quantity display components, masters screens, Home, Orders, Order detail with its sheets, and the new-order wizard (also used for edit and duplicate).

**Tech Stack:** as F1 (TypeScript strict, zod 4, Vitest + fast-check, Expo Router, TanStack Query, Zustand, react-hook-form, jest-expo + RNTL 14). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md` — read §3, §4 Masters + Orders, §5.1, §5.3, §5.4, §5.5, §5.6, §5.7, §7 (orders, masters, error contract), §8.2, §8.3 flows 1, 4, 6, 9, §8.4, §10.1, §10.3 scenarios 1 and 4. UI and copy: design canvas https://claude.ai/artifact/1cf17fda-d3a4-498b-b46d-c67fdc49f795 boards 02 Home, 03 Orders, 04 Order detail, 05 Party, 07–10 New order, 18 Parties, 19 Party form, 20 Transporter, 21 Products, 22 Product form, 29 Unit switcher, 30 Order actions, 31 Short close, 32 Delete, 38 Empty state. Read a board with the Artifact tool (`action: read`, `path: project/<Board>.dc.html`).

## Global Constraints

Everything in the F1 plan's Global Constraints still holds. In addition:

- Quantities integer kg; money integer ₹; rates whole ₹/MT; `roundHalfUp` is the only rounding, done once per value: `lineValue = roundHalfUp(orderedKg × billedRate / 1000)`.
- Bounds (schema-enforced, keep products < 2^53): `orderedKg` 1…10,000,000 per line; rates and overprice 0…10,000,000 ₹/MT; commission 0…100,000 ₹/MT.
- Status is derived, never stored (§5.3 tables, first match wins).
- Pending is per line, never netted across lines; `pending = max(0, ordered − dispatched − closed)`.
- Numbers: parent `SO-YYMM-NNNN`, one series per tenant per financial year (1 Apr–31 Mar IST), YYMM from the IST creation date, NNNN zero-padded to ≥ 4 digits; sub-order = `<parent>-A`, `-B` in the order companies were added. Issued by the server only; drafts have no number.
- Drafts: server-side, app autosaves 3 s after the last change, versioned, purged 7 days after last update.
- Money keys omitted for `plant_head` (and supervisor): every new money field name must be in `MONEY_KEYS`.
- Plant scope for orders: a plant head sees only sub-orders whose company owns one of their plants; orders with none are 404. Supervisors have no `order.view`.
- Every mutation sends `version` where the record has one; mismatch → `409 STALE`.
- UI copy comes from the canvas boards listed above; where the canvas shows the retired "Gross weighed" status, omit it (§11.1).

## Rulings (decided while planning — conflicts and gaps)

1. **Sub-order numbers follow the spec (`SO-2611-0141-A`).** The F1 company field `orderPrefix` ("Starts each sub-order number") stays stored and editable but is not used in F2 numbering. Open question for the client; cost if wrong: one formatter.
2. **GSTIN "Verify" is offline:** format regex + valid state code (01–38, 97) is required; a failed mod-36 check digit is a *warning* ("Check digit doesn't match — double-check"), never a block (seed GSTINs are invented). The canvas's "Regular taxpayer" needs a GST portal API — out of scope.
3. **Lengths are integers 1–100** in `m | ft | mm`.
4. **Product display name** = `[category, grade].filter(Boolean).join(' ') + ' · ' + sizeLabel` (`TMT Fe500D · 12 mm`, `MS Billet · 100 × 100`). The canvas Product form gains a **"Made by"** company multi-select (`product_companies`, spec §4) — the canvas omits it.
5. **Product delete** only when no order line uses it; otherwise `409 PRODUCT_IN_USE` and the form offers "Make inactive".
6. **Home "In plant now"** and the Transporter "Trips this month / Vehicles seen / Recent vehicles" need real trucks → F3. F2 shows the Home without that section and the transporter's contacts only.
7. **Trucks before F3:** `TruckRec { id, tenantId, subOrderId, plantId, vehicleNo, state: 'assigned'|'at_gate'|'loading'|'dispatched'|'cancelled', tareKg: number|null, plan: {orderLineId, plannedKg}[], allocations: {orderLineId, netKg}[], cancelledAt, cancelReason, version, createdAt }`. Created only by `ContractFixtures.addTruck` and the demo seed. F3 extends, not replaces.
8. **Edit order = the wizard in edit mode** sending one `PATCH /v1/orders/:id` with the full desired line set; the server diffs and enforces §5.3 limits.
9. **WhatsApp toggles on Review** are stored on the order (`notify: { customer, broker }`); sending is F4/F5 (log-only). "Share on WhatsApp" opens `whatsapp://send?text=` with a summary in the tenant's `externalUnitBasis`.

## Review Focus

1. **Plant head opens an order that spans their company and another** → sees only their company's sub-order, no money key anywhere, order totals computed from visible sub-orders only. (Task 6 contract)
2. **Double-tap "Create order" / retry after a dropped connection** → exactly one order and one number; replay returns the same body with `Idempotent-Replay: true`. (Task 6 contract)
3. **City staff lowers a line below what was dispatched, or changes the rate of a line with dispatches** → `409 BELOW_DISPATCHED` / `409 LINE_RATE_LOCKED`; owner may change the rate; nobody may go below dispatched. (Task 7 contract)
4. **Short close while a truck already has its tare** → first call `409 OPEN_TRUCKS` listing trucks with state and tare; confirmed call cancels them and closes in one step; a sub-order with nothing dispatched is recorded as Cancelled, not Short closed. (Task 7 contract)
5. **Order booked on 31 March 23:50 IST vs 1 April 00:10 IST** → numbers come from different FY series (`…-0001` restarts) and YYMM is IST, not UTC. (Task 2 unit + Task 6 contract with the fake clock)

---

### Task 1: Shared order rules — pricing, quantities, status

**Files:**
- Create: `packages/shared/src/rules/money.ts`, `packages/shared/src/rules/quantities.ts`, `packages/shared/src/rules/status.ts`, `packages/shared/src/rules/index.ts`
- Test: `packages/shared/src/rules/money.test.ts`, `quantities.test.ts`, `status.test.ts`
- Modify: `packages/shared/src/index.ts` (export `./rules/index.ts`)

**Interfaces:**
- Produces:
  - `roundHalfUp(numerator: number, denominator: number): number` — integers ≥ 0; `Math.floor((2*n + d) / (2*d))`.
  - `lineRate(input: { method: PricingMethod; basicRate: number | null; conversionPerMt: number; typedRate: number | null }): { rate: number; rateEdited: boolean }` — `direct`: `typedRate` required. `basic_conversion`: `basic + conversion`; a `typedRate` different from that sets `rateEdited: true`.
  - `billedRate(rate: number, overprice: number): number`
  - `lineValue(orderedKg: number, billedRatePerMt: number): number`
  - `brokerEarningEstimate(lines: { orderedKg: number; overpricePerMt: number }[], commissionPerMt: number): { commission: number; overprice: number; total: number; commissionKg: number; overpriceKg: number }` — commission on all kg, overprice only on lines with overprice > 0, each part rounded once, `total = commission + overprice`.
  - `LineQty = { orderedKg; dispatchedKg; closedKg; reservedKg }` and `pending(l)`, `over(l)`, `assignable(l)` (may be negative).
  - `SubOrderStatus = 'open'|'partly_dispatched'|'completed'|'short_closed'|'cancelled'`, `OrderStatus = SubOrderStatus | 'draft'`.
  - `subOrderStatus(s: { closeKind: CloseKind | null; lines: LineQty[] }): SubOrderStatus`, `orderStatus(o: { isDraft: boolean; subOrders: SubOrderStatus[] }): OrderStatus`, `isTerminal(s: SubOrderStatus): boolean`.
  - `CloseKind = 'short_close' | 'cancel' | 'tolerance'`; `SHORT_CLOSE_REASONS = ['Customer stopped lifting','Rate changed','Stock not available','Other'] as const`.

- [ ] **Step 1: Write the failing tests**

`money.test.ts`:
```ts
it('canvas line: 24.000 MT × ₹46,000 + ₹300 overprice = ₹11,11,200', () => {
  expect(lineValue(24_000, billedRate(46_000, 300))).toBe(1_111_200);
});
it('basic + conversion: ₹44,500 + ₹1,500 = ₹46,000, not edited; typed ₹46,300 is edited', () => {
  expect(lineRate({ method: 'basic_conversion', basicRate: 44_500, conversionPerMt: 1_500, typedRate: null })).toEqual({ rate: 46_000, rateEdited: false });
  expect(lineRate({ method: 'basic_conversion', basicRate: 44_500, conversionPerMt: 1_500, typedRate: 46_300 })).toEqual({ rate: 46_300, rateEdited: true });
});
it('canvas review estimate: 84 MT × ₹150 = ₹12,600; 74 MT × ₹300 = ₹22,200; total ₹34,800', () => {
  const lines = [{ orderedKg: 24_000, overpricePerMt: 300 }, { orderedKg: 10_000, overpricePerMt: 0 }, { orderedKg: 20_000, overpricePerMt: 300 }, { orderedKg: 30_000, overpricePerMt: 300 }];
  expect(brokerEarningEstimate(lines, 150)).toEqual({ commission: 12_600, overprice: 22_200, total: 34_800, commissionKg: 84_000, overpriceKg: 74_000 });
});
it('half-up: 1 kg × ₹500 = ₹0.5 → ₹1; 1 kg × ₹499 → ₹0', () => { /* roundHalfUp(500,1000)=1, (499,1000)=0 */ });
it('property: lineValue is identical whether the rate was typed as ₹/MT or ₹/kg', () => { /* fast-check: parseRateInput(toDisplayRate(r,'kg'),'kg') === r and lineValue unchanged */ });
```
`quantities.test.ts`: pending never negative (fast-check over 0…1e7); `over` when dispatched > ordered; `assignable` = pending − reserved and may be negative; pending of 48,000 ordered / 48,240 dispatched is 0 with over 240.
`status.test.ts`: one `it.each` row per §5.3 sub-order table row in order (cancel beats everything; tolerance → completed; pending 0 & dispatched > 0 → completed; dispatched > 0 → partly; else open), and per parent row: draft; all cancelled → cancelled; all terminal + ≥1 short closed → short_closed; all terminal → completed; any dispatched → partly_dispatched; else open. Include: `[completed, cancelled]` → completed; `[short_closed, cancelled]` → short_closed.

- [ ] **Step 2: Run, verify they fail** — `pnpm --filter @tonnage/shared exec vitest run src/rules` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three files exactly per Interfaces; no rounding anywhere except `roundHalfUp`.
- [ ] **Step 4: Run, verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(shared): order pricing, quantity and status rules`

---

### Task 2: Shared — numbering, GSTIN, products, errors, money keys

**Files:**
- Create: `packages/shared/src/rules/numbering.ts`, `packages/shared/src/gstin.ts`, `packages/shared/src/products.ts`
- Test: `packages/shared/src/rules/numbering.test.ts`, `packages/shared/src/gstin.test.ts`, `packages/shared/src/products.test.ts`
- Modify: `packages/shared/src/errors.ts`, `packages/shared/src/redact.ts`, `packages/shared/src/index.ts`, `packages/shared/src/redact.test.ts`

**Interfaces:**
- Produces:
  - `istDateParts(at: string | number): { year: number; month: number; day: number }` (Asia/Kolkata, fixed +05:30, no Intl dependency).
  - `financialYear(at): string` → `'2026-27'` (April starts a new FY).
  - `formatOrderNumber(format: string, at, seq: number): string` — replaces `YYMM` with IST yy+mm and the trailing digit run with `seq` zero-padded to that run's length (min 4); `'SO-YYMM-0001'`, 2026-11-06, 142 → `'SO-2611-0142'`; seq 12345 → `'SO-2611-12345'`.
  - `subOrderSuffix(index: number): string` → 0→`A`, 25→`Z`, 26→`AA`.
  - `subOrderNumber(orderNumber: string, suffix: string): string` → `'SO-2611-0141-A'`.
  - `checkGstin(v: string): { ok: false; reason: 'format' | 'state' } | { ok: true; state: string; checksumOk: boolean }` and `GSTIN_STATES: Record<string, string>` (`'22'`→`'Chhattisgarh'`, `'27'`→`'Maharashtra'`, …).
  - `productDisplayName(p: { category: string; grade: string; sizeLabel: string }): string` (Ruling 4), `categoryTag(category: string): string` → first 3 letters of the last word, upper case (`TMT`, `BIL`, `ING`, `ANG`, `CHA`).
  - New `ERROR_CODES`: `GSTIN_EXISTS`, `PARTY_IN_USE`, `PRODUCT_IN_USE`, `PRODUCT_NOT_FOR_COMPANY`, `COMPANY_INACTIVE`, `COMPANY_HAS_OPEN_ORDERS`, `ORDER_LOCKED`, `LINE_RATE_LOCKED`, `BELOW_DISPATCHED`, `LINE_HAS_DISPATCHES`, `OPEN_TRUCKS`, `ALREADY_CLOSED`, `NOT_CLOSED`, `HARD_DELETE_DISABLED`, `CONFIRMATION_MISMATCH`, `MOVE_EXCEEDS_AVAILABLE`, `DRAFT_INCOMPLETE`. Each gets a default English `message` where F1 defines messages.
  - `MONEY_KEYS` adds `estimatedValue` and `brokerEarningEstimate` (the whole estimate object goes). Do not add generic names like `total` or `commission`: they would strip non-money fields elsewhere. Existing `value`, `lineValue`, `rate`, `basicRate*`, `conversion*`, `overpricePerMt`, `commissionPerMt*` already cover the rest.

- [ ] **Step 1: Write the failing tests** — numbering: `financialYear('2027-03-31T18:20:00Z')` (= 31 Mar 23:50 IST) → `'2026-27'`; `financialYear('2027-03-31T18:40:00Z')` (= 1 Apr 00:10 IST) → `'2027-28'`; `formatOrderNumber('SO-YYMM-0001', '2026-10-31T19:00:00Z', 7)` → `'SO-2611-0007'` (IST is already 1 Nov). GSTIN: `'27AAKFS1234L1Z5'` ok, state Maharashtra; `'99AAKFS1234L1Z5'` → state; `'27AAKFS1234L1Z'` → format; a valid real-checksum GSTIN (compute one in the test with the mod-36 algorithm) → `checksumOk: true`, same with last char changed → `checksumOk: false`. Products: the two Ruling-4 names; tags. Redact: a nested order with `estimatedValue` and `brokerEarningEstimate` → both gone for plant_head, `totals.pendingKg` kept.
- [ ] **Step 2: Run** `pnpm --filter @tonnage/shared exec vitest run` → new tests FAIL.
- [ ] **Step 3: Implement.** Mod-36 GSTIN checksum: chars `0-9A-Z` map 0–35; for i in 0..13, factor = 1 if i even else 2; `p = v*factor; sum += floor(p/36) + p%36`; check = `(36 - sum%36) % 36`.
- [ ] **Step 4: Run** → PASS (whole shared suite, including the F1 redact test).
- [ ] **Step 5: Commit** — `feat(shared): order numbering, GSTIN check, product names, F2 error codes`

---

### Task 3: Shared zod schemas — masters and orders

**Files:**
- Create: `packages/shared/src/schemas/masters.ts`, `packages/shared/src/schemas/orders.ts`
- Test: `packages/shared/src/schemas/masters.test.ts`, `packages/shared/src/schemas/orders.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `uuidSchema`, `isoDateSchema`, `normalizedMobileSchema` from `schemas/common.ts`/`mobile.ts`; `CloseKind`, `SHORT_CLOSE_REASONS`, status types from Task 1.
- Produces (response schemas are what the app parses; body schemas validate requests):
  - `partyTypeSchema = z.enum(['customer','broker','transporter'])`
  - `contactSchema = { id?, name (1–80), roleLabel (0–30), numbers: [{ id?, number: normalizedMobile-or-landline (6–15 digits after normalising, landlines kept as typed digits with +91), label (0–20), whatsapp: boolean }] (1–5) }` (1–10 contacts)
  - `addressSchema = { id?, kind: 'bill_to'|'ship_to', label (0–40), address (1–200), isDefault: boolean }`
  - `partyBodySchema = { type, name (1–120), gstin: string|null, city (1–60), defaultCommissionPerMt: int|null (brokers only, else must be null), paymentTermsText (0–200), isSelfTransporter: boolean, contacts, addresses }` with refinements: customers need exactly one `bill_to` and ≥ 1 `ship_to` with exactly one default; brokers/transporters may have none. `updatePartyBodySchema = partyBodySchema.extend({ version, active: boolean })`.
  - `partySchema` (detail: body fields + `id, active, version, stats: { openOrders: number; pendingKg: number; fyDispatchedKg: number }`), `partySummarySchema` (list row: `id, type, name, city, gstin, active, people, numbers, pendingKg, dueRupees?: number` — `dueRupees` is F4, omit now).
  - `productBodySchema = { category (1–30), grade (0–30), sizeLabel (1–30), conversionPerMt: int 0…100,000, standardLengths: { value: int 1–100, unit: 'm'|'ft'|'mm' }[] (0–8, unique), companyIds: uuid[] (≥ 1) }`; `updateProductBodySchema` adds `version, active`. `productSchema` adds `id, displayName, tag, active, version`.
  - `lengthSchema = { value: int 1–100, unit }`
  - `orderLineInputSchema = { id?: uuid, productId, length: lengthSchema, orderedKg: int 1…10,000,000, typedRate: int|null, overpricePerMt: int 0…10,000,000, version?: int }`
  - `subOrderInputSchema = { id?: uuid, companyId, lines: orderLineInputSchema[] (1–30) }`
  - `orderTypeSchema = z.enum(['customer_broker','customer','broker_only'])`
  - `createOrderBodySchema = { draftId: uuid|null, type, customerId: uuid|null, brokerId: uuid|null, commissionPerMt: int|null, billToId: uuid|null, shipToId: uuid|null, pricingMethod, basicRate: int|null, subOrders (1–10, unique companyId), notify: { customer: boolean, broker: boolean } }` with refinements: `customer` and `customer_broker` need customer + bill/ship; `broker_only` and `customer_broker` need broker; `basic_conversion` needs `basicRate`; `direct` needs every line's `typedRate`.
  - `updateOrderBodySchema = createOrderBodySchema.omit({ draftId }).extend({ version: int, subOrders: subOrderInputSchema with optional version on sub-order })`
  - `draftBodySchema = { payload: z.record(z.unknown()) (≤ 64 KB when JSON-stringified) , version?: int }`; `draftSchema = { id, payload, version, updatedAt, createdBy }`
  - `orderLineSchema = { id, productId, productName, length, orderedKg, dispatchedKg, closedKg, reservedKg, pendingKg, overKg, rate, rateEdited, basicRateSnapshot, conversionSnapshot, overpricePerMt, lineValue, version }`
  - `subOrderSchema = { id, number, suffix, companyId, companyCode, companyName, status, closeKind, closeReason, closeNote, closedAt, closedBy, lines, totals: { orderedKg, dispatchedKg, pendingKg, closedKg, overKg }, openTrucks: { id, vehicleNo, state, tareKg }[], value, version }`
  - `orderSchema` (detail) = `{ id, number, status, type, customer: {id,name,city}|null, broker: {id,name,city}|null, commissionPerMtSnapshot, billTo, shipTo (address objects|null), pricingMethod, basicRate, notify, subOrders, totals, estimatedValue, brokerEarningEstimate, ageDays, isAged, createdAt, createdBy: {id,name}, version }`
  - `orderSummarySchema` (list row) = `{ id, number, status, customerName|null, customerCity|null, brokerName|null, type, companyCodes: string[], productsLabel (e.g. "TMT 12, 16 mm"), totals, estimatedValue, createdAt, isAged }`
  - `orderListQuerySchema = { status?: 'all'|'open'|'partly_dispatched'|'completed'|'short_closed'|'cancelled', companyId?: uuid, q?: string (≤ 60), sort?: 'newest'|'oldest', cursor?: string, limit?: 1–50 default 20 }`; `orderListSchema = { items, counts: Record<'all'|'open'|'partly_dispatched'|'completed'|'short_closed'|'cancelled', number>, nextCursor: string|null }`
  - `homeSchema = { pendingKg, openOrders, unitCount, perCompany: { companyId, code, name, pendingKg }[], agedOrders, bookedToday: { kg, orders, value }, dispatchedToday: { kg, trucks }, sentThisWeek: { kg, changePct: number|null } }`
  - `shortCloseBodySchema = { reason: enum(SHORT_CLOSE_REASONS), note: string (0–200), cancelOpenTrucks: boolean, version }`; `reopenBodySchema = { version }`
  - `moveQuantityBodySchema = { fromLineId, toCompanyId, kg: int ≥ 1, version }` (order version)
  - `deleteOrderBodySchema = { confirmNumber: string }`; `deletePreviewSchema = { subOrders, lines, trucks, dispatchedKg, weighments }`
  - `activityEntrySchema = { id, action, actorName, at, meta }`

- [ ] **Step 1: Write the failing tests** — accepts the canvas order (AIP 3 lines, KRM 1 line, `basic_conversion` 44,500, broker R.K. Agarwal, commission 150); rejects: `customer_broker` without broker (path `['brokerId']`), `direct` with a line missing `typedRate` (path `['subOrders',0,'lines',1,'typedRate']`), two sub-orders with the same company, length 101, orderedKg 0, customer party with two bill-to addresses, broker with a commission on a customer type; `orderSummarySchema` parses a plant-head-redacted row (money keys absent).
- [ ] **Step 2: Run** `pnpm --filter @tonnage/shared exec vitest run src/schemas` → FAIL.
- [ ] **Step 3: Implement** per Interfaces. Money fields in responses are `.optional()` so redacted payloads parse.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(shared): masters and orders schemas`

---

### Task 4: Mock store v2, demo seed and contract fixtures

**Files:**
- Modify: `packages/mock-api/src/store.ts` (records + `SNAPSHOT_VERSION = 2`), `packages/mock-api/src/index.ts`, `packages/shared/src/fixtures/sample-world.ts` (+ `sample-world.test.ts`), `packages/contract-tests/src/harness.ts`, `packages/contract-tests/src/mock.test.ts`
- Create: `packages/mock-api/src/seed-orders.ts`, `packages/mock-api/src/orders-math.ts`
- Test: `packages/mock-api/src/store.test.ts`, `packages/mock-api/src/orders-math.test.ts`

**Interfaces:**
- Consumes: Task 1 rules; Task 2 numbering.
- Produces:
  - Records: `PartyRec` (spec §4 parties + `contacts`, `addresses` nested, `version`), `ProductRec` (+ `companyIds`), `OrderRec` (§4 orders incl. `notify`, `commissionPerMtSnapshot`, `isDraft:false` only — drafts live in `DraftRec { id, tenantId, createdBy, payload, version, createdAt, updatedAt }`), `SubOrderRec`, `OrderLineRec` (§4), `TruckRec` (Ruling 7), `NumberSeriesRec { tenantId, key, fy, next }`.
  - `MockState` adds `parties, products, orders, subOrders, orderLines, trucks, drafts, numberSeries`.
  - A snapshot whose `schemaVersion !== 2` is discarded and the seed reloaded (existing F1 behaviour); demo users' F1 changes are lost once — acceptable for a demo store.
  - `orders-math.ts`: `lineQty(state, line): LineQty` (dispatched = Σ allocations of `dispatched` trucks; reserved = Σ plan of `assigned|at_gate|loading` trucks), `subOrderView(state, sub)`, `orderStatusOf(state, order)`, `nextNumber(state, tenantId, key, at): number` (per FY, starts at 1).
  - `SAMPLE_WORLD` adds `parties` (Shubham Traders — customer, Nagpur, GSTIN `27AAKFS1234L1Z5`, contacts Suresh Jain Owner `+919826012345` mobile+WhatsApp & `+917122551234` office, Amit Verma Accounts `+919425067890`; bill-to Plot 14, Wardhaman Nagar, Nagpur 440008; ship-to Hingna MIDC site (default), Butibori yard, Kamptee Road godown · Patel Infra Projects — customer, Indore · Krishna Construction — customer, Bhilai · Gupta Hardware — customer, Durg · R.K. Agarwal — broker, Raipur, commission 150 · Mittal Brokers — broker, Raipur, commission 120 · Shree Ganesh Roadlines — transporter, Raipur, GSTIN `22AEXPG5521K1Z9`, Manoj Sahu Owner `+919893044120`), `products` (TMT Fe500D 8/12/16/20/25 mm with conversions 2,200/1,500/1,000/800/600 and standard lengths 12 m (12 mm: 6 m, 12 m) made by AIP+KRM; MS Billet · 100 × 100 conv 0, 6 m, NAP+VSL; MS Ingot · 4 inch conv 0, none, NAP; Angle · 50 × 50 × 5 conv 2,800, 6 m, VSL; Channel · 75 × 40 conv 3,100, 6 m + 12 m, VSL) and ids under `ids.parties` / `ids.products` (`019a4c00-0004-…` / `019a4c00-0005-…`).
  - `seed-orders.ts`: `seedDemoOrders(state, clock)` — demo store only (not contract): the five canvas order rows (SO-2611-0142 Open AIP+KRM 84 MT; -0141 Partly dispatched KRM 120 MT with 2 dispatched trucks 72.400 MT + 1 loading truck; -0139 broker-only Mittal 60 MT AIP+NAP; SO-2610-0136 Short closed NAP 42 MT 30.200 dispatched; SO-2610-0131 Completed KRM 48 MT with 48.240 dispatched) and number series continued from them.
  - `ContractFixtures` gains `addTruck(input: { subOrderId: string; state: TruckRec['state']; vehicleNo: string; tareKg?: number; plan: { orderLineId: string; plannedKg: number }[]; allocations?: { orderLineId: string; netKg: number }[] }): Promise<{ truckId: string }>` — the B2 target implements it with direct SQL.
  - `MockControls.addTruck` with the same signature as `ContractFixtures.addTruck` (the mock target's fixture delegates to it); app tests and Demo tools use it.
  - `createMockApi({ seedOrders?: boolean })` — `true` in the app (`getMockApi`), default `false` (contract and unit tests start without orders).

- [ ] **Step 1: Write the failing tests** — store: a v1 snapshot loads the fresh v2 seed; seed has 8 parties, 9 products; `seedDemoOrders` gives statuses `[open, partly_dispatched, open, short_closed, completed]` for the five numbers and the next number in Nov 2026 is `SO-2611-0143`. orders-math: a cancelled truck's plan is not reserved; a dispatched truck's allocations count once.
- [ ] **Step 2: Run** `pnpm --filter @tonnage/mock-api exec vitest run` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** mock-api and contract-tests suites → PASS (F1 contract suite unchanged).
- [ ] **Step 5: Commit** — `feat(mock-api): v2 store with masters, orders, trucks and demo seed`

---

### Task 5: Masters API — parties and products (mock + contract)

**Files:**
- Create: `packages/mock-api/src/handlers/parties.ts`, `packages/mock-api/src/handlers/products.ts`, `packages/contract-tests/src/suites/masters.contract.ts`
- Modify: `packages/mock-api/src/handlers/index` wiring (where F1 registers routes), `packages/contract-tests/src/index.ts`, `packages/mock-api/src/handlers/companies.ts` (company deactivation guard: `COMPANY_HAS_OPEN_ORDERS` when any non-terminal sub-order exists — fills the F1 hook)

**Interfaces:**
- Routes (all `masters.manage` unless noted): `GET /v1/parties?type=&q=&active=` → `partySummarySchema[]` sorted by name; `GET /v1/parties/:id`; `POST /v1/parties` (idempotent); `PATCH /v1/parties/:id`; `GET /v1/products?category=&q=&companyId=&active=`; `GET /v1/products/:id`; `POST /v1/products` (idempotent); `PATCH /v1/products/:id`; `DELETE /v1/products/:id` (`PRODUCT_IN_USE`).
- GSTIN unique per tenant across parties → `409 GSTIN_EXISTS` with `details: { partyId, name }`. Party deactivation allowed always; deactivated parties are hidden from the wizard pickers (`active=true`) but still shown on old orders.
- `q` matches name, city, GSTIN, any contact name or number (digits-only compare), case-insensitive.

- [ ] **Step 1: Write the failing contract tests** (`masters.contract.ts`): owner creates a broker with commission 150 → 201, detail round-trips contacts and numbers normalised to `+91…`; same GSTIN again → `409 GSTIN_EXISTS`; customer without ship-to → `422` path `['addresses']`; Kiran (plant head) and Ravi (supervisor) → `403` on `GET /v1/parties` (role, not scope); stale `PATCH` → `409 STALE`; search `98260 12345` finds Shubham Traders; product create with `companyIds: []` → 422; product list `companyId=NAP` returns only NAP-made products; deleting a product used on an order line → `409 PRODUCT_IN_USE` (uses an order created through `POST /v1/orders` in Task 6 — mark this one test `it.todo` here and enable it in Task 6); deactivating KRM while it has an open sub-order → `409 COMPANY_HAS_OPEN_ORDERS` (also enabled in Task 6).
- [ ] **Step 2: Run** `pnpm --filter @tonnage/contract-tests exec vitest run -t "masters"` → FAIL.
- [ ] **Step 3: Implement** the handlers following `companies.ts` patterns (`authed`, `logActivity`, `stale()`, idempotent create).
- [ ] **Step 4: Run** → PASS; full contract suite green.
- [ ] **Step 5: Commit** — `feat(mock-api): parties and products`

---

### Task 6: Orders API — create, list, detail, home, drafts, duplicate

**Files:**
- Create: `packages/mock-api/src/handlers/orders.ts`, `packages/mock-api/src/handlers/drafts.ts`, `packages/mock-api/src/handlers/home.ts`, `packages/contract-tests/src/suites/orders.contract.ts`
- Modify: route wiring; `masters.contract.ts` (enable the two `todo`s)

**Interfaces:**
- Routes: `POST /v1/orders` (`order.create`, idempotent) → 201 `orderSchema`; `GET /v1/orders` (`order.view`) → `orderListSchema`; `GET /v1/orders/:id` (`order.view`); `GET /v1/home?companyId=` (`order.view`) → `homeSchema`; `POST /v1/orders/drafts` (`order.create`, idempotent) → `draftSchema`; `GET /v1/orders/drafts` (own drafts; owner sees all) ; `GET|PUT|DELETE /v1/orders/drafts/:id`; `POST /v1/orders/:id/duplicate` (`order.duplicate`, idempotent) → `draftSchema`.
- Register the `/v1/orders/drafts…` routes **before** `/v1/orders/:id` so `drafts` is never read as an order id (add a router test).
- Create rules: every party/product/company exists, is active and in tenant (`404`/`422`); every line's product is made by its sub-order's company (`409 PRODUCT_NOT_FOR_COMPANY`, details `{ subOrderIndex, lineIndex }`); inactive company → `409 COMPANY_INACTIVE`; snapshot `basicRateSnapshot`, `conversionSnapshot` (product's conversion now), `commissionPerMtSnapshot` (body value, defaulting to the broker's `defaultCommissionPerMt`); number from `nextNumber(tenant, 'order', now)`; suffixes in body order; `draftId` given → draft deleted in the same step; `activity` `order.created`.
- Response totals: server-computed (`lineValue`, `brokerEarningEstimate`); the app shows the server's numbers after create.
- List: `status` filter on derived status; `companyId` keeps orders having a sub-order of that company and computes totals on those sub-orders only; `q` matches number (digits-tolerant: `0142` finds `SO-2611-0142`), customer, broker, and (F3) vehicle; cursor = opaque base64 of `{createdAt,id}`; `counts` reflect `companyId` + `q` but not `status`. Plant head: same with plant scope; money redacted by the F1 pipeline.
- Home: computed from orders in scope and `companyId`; `agedOrders` = orders with pending > 0 and `ageDays > agedOrderDays`; IST "today" and "this week" (Mon–Sun) via `istDateParts`.
- Drafts: purge on every drafts read where `updatedAt` older than 7 days; `PUT` with stale `version` → 409.

- [ ] **Step 1: Write the failing contract tests** — Review Focus 1, 2 and 5 exactly as written there, plus: create the canvas order → 201, number `SO-2611-0001` (fake clock 2026-11-03), sub-orders `-A` AIP and `-B` KRM, `estimatedValue` 3,864,200 and `brokerEarningEstimate.total` 34,800; 16 mm on NAP → `409 PRODUCT_NOT_FOR_COMPANY`; list `q=0001` finds it; `companyId=KRM` row shows 30,000 kg ordered; drafts: create → put twice with versions → stale put 409 → advance fake clock 8 days → gone; duplicate returns a draft whose payload re-creates the same order.
- [ ] **Step 2: Run** `-t "orders"` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; whole contract suite green.
- [ ] **Step 5: Commit** — `feat(mock-api): orders create, list, detail, home, drafts`

---

### Task 7: Order lifecycle API — edit, short close, reopen, move, delete, activity

**Files:**
- Create: `packages/shared/src/rules/edits.ts` (+ `edits.test.ts`), `packages/mock-api/src/handlers/order-lifecycle.ts`, `packages/contract-tests/src/suites/order-lifecycle.contract.ts`

**Interfaces:**
- `planOrderEdit(input: { role: Role; existing: { lineId, orderedKg, rate, overpricePerMt, dispatchedKg, reservedKg, subOrderTerminal: boolean }[]; desired: { lineId?: string; orderedKg; rate; overpricePerMt }[] }): { errors: { lineId?: string; code: 'BELOW_DISPATCHED'|'LINE_RATE_LOCKED'|'LINE_HAS_DISPATCHES'|'ORDER_LOCKED' }[]; warnings: { lineId: string; code: 'BELOW_RESERVED' }[] }` — rules from §5.3 "Edits after dispatch starts": non-owner may add lines and change lines with zero dispatches; lines with dispatches are rate/overprice-locked for non-owner; nobody below dispatched; removing a line with dispatches → `LINE_HAS_DISPATCHES`; editing a terminal sub-order → `ORDER_LOCKED` (owner must reopen first).
- Routes: `PATCH /v1/orders/:id` (`order.edit`; owner-only parts checked by `planOrderEdit`) → `orderSchema` with `warnings` in a `meta` field; `POST /v1/sub-orders/:id/short-close` (`order.shortClose`); `POST /v1/sub-orders/:id/reopen` (`order.reopen`); `POST /v1/orders/:id/move-quantity` (`order.edit`); `GET /v1/orders/:id/delete-preview` and `DELETE /v1/orders/:id` (`order.hardDelete`); `GET /v1/orders/:id/activity` (`order.view`, newest first).
- Short close: already closed → `409 ALREADY_CLOSED`; open trucks (`assigned|at_gate|loading`) and `cancelOpenTrucks: false` → `409 OPEN_TRUCKS` with `details.trucks`; with `true`, cancel them (`cancelReason: 'Order short closed'`) and close; `closedKg = pending` per line; dispatched 0 → `closeKind: 'cancel'`.
- Reopen: not closed → `409 NOT_CLOSED`; clears `close*` and every line's `closedKg`.
- Move: `kg ≤ max(0, assignable(fromLine))` else `409 MOVE_EXCEEDS_AVAILABLE` with `details.availableKg`; target company must make the product; target sub-order created with the next suffix when missing; target line matched by product + length + rate + overprice, else created; source line `orderedKg -= kg` (a line reaching 0 with nothing dispatched is removed); one activity entry `order.quantity_moved` with from/to/kg.
- Delete: `confirmNumber !== number` → `409 CONFIRMATION_MISMATCH`; any dispatched and `allowHardDeleteAfterDispatch === false` → `409 HARD_DELETE_DISABLED`; removes order, sub-orders, lines, trucks, activity for the order; `204`.

- [ ] **Step 1: Write the failing tests** — `edits.test.ts` table for owner vs city staff covering each code; contract: Review Focus 3 and 4 as written; reopen by Priya → 403, by Rajesh → status back to Partly dispatched; move 10 MT from AIP 12 mm line to KRM → AIP line −10,000 kg, KRM line +10,000 kg, order total unchanged; move more than available → 409 with `availableKg`; delete with wrong confirm → 409; delete preview counts on an order with 2 trucks; after delete `GET` → 404 and activity gone.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** shared + mock + contract suites → PASS.
- [ ] **Step 5: Commit** — `feat: order edit limits, short close, reopen, move quantity, hard delete`

---

### Task 8: App data layer — unit filter, query hooks, display components

**Files:**
- Create: `apps/mobile/src/api/hooks/masters.ts`, `apps/mobile/src/api/hooks/orders.ts`, `apps/mobile/src/prefs/unitFilter.ts`, `apps/mobile/src/ui/QtyText.tsx`, `MoneyText.tsx`, `UnitTag.tsx`, `ProgressBar.tsx`, `Chip.tsx`, `SearchField.tsx`, `apps/mobile/src/screens/UnitSwitcherSheet.tsx`
- Modify: `apps/mobile/src/ui/index.ts`, `apps/mobile/src/theme/tokens.ts` (unit tag colour slots from canvas: AIP brs/brt, VSL vis/vi, KRM oks/okt, NAP wns/wnt; 5th+ company cycles), `apps/mobile/src/api/hooks/me.ts` (expose `useUnitBasis()` if not already)
- Test: `apps/mobile/test/data-layer.test.tsx`

**Interfaces:**
- `useUnitFilter(): { companyId: string | 'all'; set(id): void }` — Zustand, persisted to AsyncStorage key `tonnage.unitFilter`, reset to `'all'` on person change (same identity wipe as F1 query cache) and when the chosen company is no longer visible.
- Query keys: `['parties', filters]`, `['party', id]`, `['products', filters]`, `['orders', companyId, status, q, sort]` (infinite), `['order', id]`, `['home', companyId]`, `['drafts']`, `['order-activity', id]`. Mutations invalidate `orders`, `order`, `home`, plus `parties` on party change. **No optimistic updates** for quantities, money or status (§8.2).
- `QtyText({ kg, unit?: boolean, tone? })` and `MoneyText({ rupees, short?: boolean })` render nothing when the value is `undefined` (redacted) — callers need no role checks; `MoneyText short` uses `formatRupeesShort`.
- `UnitTag({ code })`, `ProgressBar({ value: 0..1, tone: 'bar'|'ok'|'muted' })`, `Chip({ label, count?, selected, onPress })` (44 dp touch target via hitSlop), `SearchField` (300 ms debounce, clear button labelled "Clear search").
- `UnitSwitcherSheet` — canvas board 29: "View data for" / "Every screen filters to this choice", rows All units + each visible company with pending in the user's basis; selected row has a check; uses F1 `Sheet`.

- [ ] **Step 1: Write the failing tests** — QtyText shows `24.180 MT` for an MT user and `24,180 kg` for a kg user from the same `kg`; MoneyText renders nothing for `undefined`; picking KRM in the switcher changes the Orders query key and the Home figure (mock with seeded orders); filter resets to All when switching person.
- [ ] **Step 2: Run** `pnpm --filter mobile exec jest test/data-layer.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(mobile): unit switcher, order/master hooks, quantity and money components`

---

### Task 9: Parties screens — list, detail, form, transporter

**Files:**
- Create: `apps/mobile/app/(app)/parties/index.tsx`, `[id].tsx`, `new.tsx`, `[id]/edit.tsx`; `apps/mobile/src/screens/parties/PartiesScreen.tsx`, `PartyDetailScreen.tsx`, `PartyFormScreen.tsx`, `ContactEditor.tsx`, `AddressEditor.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx` (enable "Customers & brokers", "Transporters" rows for `masters.manage`), `apps/mobile/src/admin/forms.ts` if shared form helpers fit
- Test: `apps/mobile/test/parties.test.tsx`

**Interfaces:**
- Canvas boards 18, 05, 19, 20. List: title "Parties", caption "Shared across all N companies", search, type segmented "Customers N · Brokers N · Transporters N", rows with initials avatar, "city · N people · N numbers", right side pending (`QtyText`) or "Clear / no pending"; FAB-style bottom button "Add customer" / "Add broker" / "Add transporter" following the selected type. Detail: Call / WhatsApp / New order (customer, broker) actions using `Linking` (`tel:`, `whatsapp://send?phone=`); stats Open orders / Pending / This year; contacts with per-number call and WhatsApp icon buttons (labelled "Call +91 …", "WhatsApp +91 …"); addresses. Transporter detail = contacts only (Ruling 6). Form: type segmented (locked when editing), name, GSTIN with "Verify" showing `checkGstin` result ("Valid · Maharashtra", the check-digit warning, or the error), city, broker-only "Default commission ₹ per MT", contact people with role chips Owner/Accounts/Purchase/Site/+ Role and numbers (Mobile/Office label, WhatsApp toggle, "Add another number"), customer addresses (one Bill to, Ship to sites with Default), "Save party". Leaving with unsaved changes asks "Discard changes?".
- Errors: `GSTIN_EXISTS` → inline under GSTIN "Already used by <name>" with a link to that party; `422` paths → inline field errors; `STALE` → F1 reload pattern.

- [ ] **Step 1: Write the failing tests** — create a broker with commission 150 and two numbers → appears in the Brokers list; duplicate GSTIN shows the inline error with the other party's name; customer without ship-to cannot save (button disabled with reason text); search by phone digits; plant head deep-linking to `/parties` is redirected.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(mobile): parties list, detail and form`

---

### Task 10: Products screens

**Files:**
- Create: `apps/mobile/app/(app)/products/index.tsx`, `new.tsx`, `[id].tsx`; `apps/mobile/src/screens/products/ProductsScreen.tsx`, `ProductFormScreen.tsx`
- Modify: `MoreScreen.tsx` (enable "Products")
- Test: `apps/mobile/test/products.test.tsx`

**Interfaces:**
- Boards 21, 22 + Ruling 4/5: list caption "One list for every company · N products", search, category chips with counts, header "Product · Conversion / MT", rows with `categoryTag` badge, display name, "Lengths 6 m, 12 m" or "No standard length", conversion "+₹1,500" (in the user's basis: "+₹1.500 / kg" for kg users). Form: category chips from existing categories + "+ New", grade, size, live "Shown in orders as", conversion with the canvas helper text using the user's basis, standard lengths chips + "+ Add" (value + unit), **Made by** company checkboxes, Active switch "Inactive products are hidden from new orders", Delete (shows `PRODUCT_IN_USE` → offers "Make inactive").

- [ ] **Step 1: Write the failing tests** — create "Angle · 65 × 65 × 6" for VSL only, conversion 2,800 → listed under Angle; kg user types conversion "2.8" → stored 2,800; delete of a product on an order → "Make inactive" offered and works.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** — `feat(mobile): products list and form`

---

### Task 11: Home and Orders list (+ first-run empty state)

**Files:**
- Modify: `apps/mobile/app/(app)/(tabs)/home.tsx`, `orders.tsx`
- Create: `apps/mobile/src/screens/home/HomeScreen.tsx`, `apps/mobile/src/screens/orders/OrdersScreen.tsx`, `OrderCard.tsx`, `OrdersSummary.tsx`, `FirstRun.tsx`, `apps/mobile/src/screens/orders/statusMeta.ts`
- Test: `apps/mobile/test/home-orders.test.tsx`

**Interfaces:**
- `statusMeta(status): { label: string; kind: BadgeKind }` — Open → `br`, Partly dispatched → `wn`, Completed → `ok`, Short closed → `nu`, Cancelled → `dg`, Draft → `nu`.
- Home (board 02 minus "In plant now", Ruling 6): unit switcher pill (opens `UnitSwitcherSheet`), date caption in IST, greeting by IST hour (Good morning < 12, Good afternoon < 17, Good evening), Pending dispatch card (big quantity, "N open orders across N units", per-company bar + legend, aged badge "N older than D days" → Orders filtered to aged), Booked today / Dispatched today tiles (money parts hidden for plant head by `MoneyText`). Pull to refresh.
- Orders (board 03): title, search "Order no, party, broker, vehicle", summary card (Pending to dispatch, Older than D days, Sent this week), status chips with counts, "N orders" + sort toggle Newest/Oldest first, cards per board 03 (number, unit tags, status badge, customer or amber "Customer not added yet" for broker-only, "via broker · products · relative time", progress bar, "dispatched / ordered" + "· X closed" or "+X over", value), infinite scroll, "Drafts · N" row on top when the user has drafts. Empty (board 38): "No orders yet", copy, "Create first order", "Import from Excel" (F5 → disabled "Coming soon"), setup checklist "Getting set up · N of 4 done" computed from companies, products, parties, invited users. Plant head: same screens, no New, no money.

- [ ] **Step 1: Write the failing tests** — seeded demo: Home shows 4 per-company legend rows and the aged badge; KRM filter shows only KRM orders and KRM-only pending; chip "Short closed" lists SO-2610-0136; search "0141" finds one; a broker-only order shows "Customer not added yet"; Kiran sees no ₹ anywhere on either screen (assert no text matching `/₹/`); empty tenant (no seed orders) shows the checklist with "2 of 4 done" after products are seeded but no parties.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `feat(mobile): home dashboard and orders list`

---

### Task 12: Order detail and its sheets

**Files:**
- Create: `apps/mobile/app/(app)/orders/[id].tsx`, `apps/mobile/src/screens/orders/OrderDetailScreen.tsx`, `OrderActionsSheet.tsx`, `ShortCloseSheet.tsx`, `DeleteOrderSheet.tsx`, `MoveQuantitySheet.tsx`, `ActivitySheet.tsx`, `shareText.ts`
- Test: `apps/mobile/test/order-detail.test.tsx`

**Interfaces:**
- Detail (board 04): header back / share / more; status badge + "Created <relative> · <name>"; customer title; "<Type> order · Ship to <label>, <address>"; Dispatched card (dispatched / ordered, bar, Pending, Trucks "N + M loading", Value); per sub-order section (company name, unit tag, "Sub-order A", line rows "product · length", rate, bar, "x of y · z pending"); per sub-order closed banner when terminal ("Short closed · Customer stopped lifting · 3 Nov" with owner "Reopen"); Trucks section from `openTrucks` + dispatched trucks (F3 fills detail). Footer: "Short close" (secondary) + "Assign vehicle" (primary; F3 → shows "Coming in the next update" toast). Footer hidden for plant head and on terminal orders.
- Actions sheet (board 30): Edit order, Assign vehicle, Share on WhatsApp, Activity history, Short close "Stop the remaining X", Delete forever "Owner only · removes every record" (owner only), plus Duplicate order and Move quantity (when > 1 company or the product is made by another company).
- Short close sheet (board 31): one sub-order at a time (picker when > 1 non-terminal), title "Short close X?", copy, pending per line, reasons, note, "Keep open" / "Short close order". On `409 OPEN_TRUCKS` the sheet switches to the open-truck confirmation: list "CG 04 MK 2291 — loading, tare 12.460 t" (tare in the user's basis), extra amber "May be loading now" when `tareKg` set, button "Cancel N trucks and short close" → resend with `cancelOpenTrucks: true`.
- Delete sheet (board 32): counts from `delete-preview`, typed confirmation (case-insensitive, trims spaces), "Delete forever" danger button enabled only on match; success → back to Orders with toast "SO-… deleted".
- `shareText(order, externalUnitBasis): string` — number, customer, per sub-order lines with pending, in `externalUnitBasis`.

- [ ] **Step 1: Write the failing tests** — Review Focus 4 through the UI (seed a loading truck via `controls`/fixture; confirm text includes the vehicle and "May be loading now"); delete button disabled until the number is typed; Priya does not see "Delete forever" or "Reopen"; move 10 MT AIP→KRM updates both sections; share text uses MT for a kg user when tenant `externalUnitBasis` is `mt`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `feat(mobile): order detail, actions, short close, delete, move quantity`

---

### Task 13: New-order wizard — create, drafts, edit, duplicate

**Files:**
- Create: `apps/mobile/app/(app)/(tabs)/new.tsx` (replace placeholder), `apps/mobile/app/(app)/orders/[id]/edit.tsx`, `apps/mobile/app/(app)/orders/draft/[draftId].tsx`; `apps/mobile/src/screens/new-order/wizardStore.ts`, `useDraftAutosave.ts`, `PartiesStep.tsx`, `ItemsStep.tsx`, `AddLineSheet.tsx`, `ReviewStep.tsx`, `PartyPickerSheet.tsx`, `WizardScreen.tsx`
- Test: `apps/mobile/test/new-order.test.tsx`, `apps/mobile/test/wizard-store.test.ts`

**Interfaces:**
- `wizardStore` (Zustand, one per wizard session): `{ mode: 'create'|'edit'; draftId: string|null; draftVersion: number|null; orderId?; orderVersion?; step: 1|2|3; type; customerId; brokerId; commissionPerMt; billToId; shipToId; pricingMethod; basicRate; subOrders: { companyId; lines: LineDraft[] }[]; notify; submitKey: string }` with actions `setParties`, `addSubOrder(companyId)`, `upsertLine(companyId, line)`, `removeLine`, `toCreateBody()`, `toUpdateBody()`, `fromOrder(order)`, `fromDraft(draft)`. `submitKey` minted once per session (F1 `submitKey.ts`) so retries and double taps are idempotent.
- Preview totals use Task 1 rules with the same inputs the server uses; after create, if the server's `estimatedValue` differs, the success screen shows "Value updated by the server: ₹X" (server wins, §8.3).
- `useDraftAutosave(store)` — create mode only: first change creates a draft (`POST /drafts`), later changes `PUT` 3 s after the last change; "Save draft" saves now and closes; `409 STALE` on a draft → reload the draft and toast "This draft was changed on another phone". Close (×) with changes → sheet "Keep draft / Discard draft".
- Step 1 Parties (board 07): Order type segmented (Customer + broker / Customer / Broker only), customer and broker pickers (`PartyPickerSheet`: search, active only, "Add new …" → party form, returns the new id), broker commission "₹ per MT" in the user's basis with helper "Filled from the broker's profile. Changes apply to this order only.", Bill to (customer's), Ship to "1 of N" picker; Continue disabled with reason until valid.
- Step 2 Items (board 08): Pricing segmented (Direct rate / Basic + conversion), basic rate "Basic rate per MT, before GST" (₹/kg label for kg users), one section per company (name, tag, "plant · billed separately", sub-total value and quantity), lines ("product · length · rate +overprice broker", "Rate edited" tag), "Add line", "Split with another unit <names>" adds a company section; footer "N MT · N lines · before GST", value, "Review".
- `AddLineSheet` (board 09): title "Add line", company subtitle; product picker filtered to products made by that company (active), showing "+₹conv conv."; length unit segmented m/ft/mm, standard length chips + "Other…" numeric (1–100); Quantity (basis); "Rate per MT" with helper "Rate = basic ₹X + conversion ₹Y. Type to override." (or direct rate); "Broker overprice per MT" with helper naming the broker and commission (hidden for `customer` type); live "Line amount qty × rate = value"; "Add another length" keeps product and opens a new length; "Add line".
- Step 3 Review (board 10): order value, quantity/lines/units, customer, broker "· ₹150 / MT", ship to, "N sub-orders · each company bills separately" list, broker earning estimate block (commission, overprice, total, "Final amount is worked out on each truck's net weight."), WhatsApp toggles, "Create order" (edit mode: "Save changes", showing server `warnings` like below-reserved before saving). Success → order detail with toast "SO-… created".
- Edit mode: opened from order actions; prefilled via `fromOrder`; dispatched lines show "Locked · has dispatches" for non-owner (rate fields read-only, quantity min = dispatched); server 409 codes map to inline line errors.

- [ ] **Step 1: Write the failing tests** — wizard-store: canvas order → `toCreateBody()` equals the Task 3 test fixture; kg user typing rate "46.3" stores 46,300. Screen: book the canvas order end-to-end (pickers, two companies, four lines) → server number shown, value ₹38,64,200; double-tap Create sends one request (same key); autosave creates one draft after 3 s (fake timers) and a second edit `PUT`s with version 2; reopening the draft from Orders restores step and lines; broker-only hides customer fields and overprice still shows; NAP section offers no TMT products; edit as Priya of a partly dispatched order: 20 mm line rate locked, lowering 16 mm below dispatched shows the `BELOW_DISPATCHED` message.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `feat(mobile): new-order wizard with drafts, edit and duplicate`

---

### Task 14: Docs, full verification, device walkthrough

**Files:**
- Modify: `CLAUDE.md` (F2 status; rules live in `packages/shared/src/rules`; new contract suites; demo seed orders; Rulings 1, 2, 6, 7 as known gaps), `README.md` (nothing new unless setup changed)

- [ ] **Step 1: Update `CLAUDE.md`.**
- [ ] **Step 2: Full run** — `pnpm lint && pnpm typecheck && pnpm test` → all green.
- [ ] **Step 3: Emulator walkthrough** (record each ✓ in the ledger): Rajesh books spec §10.3 scenario 1 (2 companies, broker with overprice, two lengths of one product) → number issued, value matches preview; filter KRM → only KRM; switch to kg → every quantity and rate on Home, Orders, detail and wizard shows kg and ₹/kg; short-close the seeded partly-dispatched order with its loading truck → open-truck confirmation → closed; Kiran sees his orders without any ₹; Back from order detail and from the wizard returns where expected; Graphite dark on each new screen.
- [ ] **Step 4: Commit** — `docs: CLAUDE.md for F2`
