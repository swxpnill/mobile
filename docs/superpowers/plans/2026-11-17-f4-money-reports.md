# F4 Money & Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner and city staff see what each broker has earned, been paid and is owed. They record a payment (with mode, UTR, date and optional TDS), reverse a wrong one, and share a monthly statement. They run the seven reports for a date range and unit and export any of them to Excel or PDF on the phone. Plant heads and supervisors never see a rupee. F4 also closes the five items F3 parked. Everything runs against the mock API and is proven by the contract suite.

**Architecture:** Ledger maths lives in pure functions in `packages/shared/src/rules/ledger.ts` (due, payment sign, FIFO unpaid MT, month totals, statement, signed rounding). Report aggregation is pure functions in `packages/shared/src/reports/` over flat "facts" (§8.5), so B4's SQL can be checked against the same functions. `packages/mock-api` extends `BrokerLedgerRec` with payment rows (store v5). It adds the broker dues, ledger, statement, payment and reverse routes, plus a `GET /v1/reports/:kind` route that builds the facts from the store and calls the shared aggregators. The phone gets the broker profile & ledger (board 06), Record payment (board 33), a broker dues list, Reports (board 23) and an export kit. The kit turns any report or statement into one table model and from that into xlsx (SheetJS) or PDF (expo-print), written with expo-file-system and shared with expo-sharing.

**Tech Stack:** as F3. New dependencies: `expo-print`, `expo-sharing` and `expo-file-system`, all three bundled in Expo Go (`npx expo install expo-print expo-sharing expo-file-system`). Also SheetJS (pure JS, no native code) pinned from the SheetJS CDN tarball: `pnpm --filter mobile add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (Ruling 11). No other native modules.

**Spec:** `docs/superpowers/specs/2026-11-04-tonnage-design.md`. Read §1 (success criterion 3), §4 Money (`broker_ledger`) and Cross-cutting (`activity_log`), §5.4 (all of it), §5.5, §5.6 (reports, exports, external basis), §5.7 idempotency, §7 money + reports rows + error contract, §7.1, §8.3 flow 5, §8.5, §8.6, §10.3 scenarios 4 and 5, and §12 (the F4 row; notifications are F5/B4). Read the decisions register https://claude.ai/artifact/7f2fd784-5809-4ac7-ba0f-42a25abdba23 §2 (who records payments), §5 Broker money (statement and TDS Defaults), §9 (WhatsApp/push Defaults) and §11 Reports (columns and filters per report). UI and copy come from the design canvas https://claude.ai/artifact/1cf17fda-d3a4-498b-b46d-c67fdc49f795: boards 06 Broker — contacts & ledger (`BrokerLedger`), 33 Record broker payment (`RecordPayment`), 23 Reports (`Reports`), 17 More menu (`More`, the "Money & reports" group: "Broker ledger · ₹4.82 L due", "Reports") and 05 Party (`PartyDetail`, the header and contacts that 06 shares). Local copies are in `.superpowers/sdd/f4-canvas/project/`; otherwise read a board with the Artifact tool (`action: read`, `path: project/<Board>.dc.html`).

## Global Constraints

Everything in the F1–F3 plans' Global Constraints still holds. In addition:

- Money is integer rupees. No float ever enters a stored value or a sum. The only rounding is `roundHalfUp` (and `roundHalfUpSigned` for sums that can be negative, Task 1), applied once per amount the spec names.
- Ledger sign convention (§5.4): `amountRupees` is signed in the broker's favour. An earning is positive. A payment is `−(paidRupees + tdsRupees)`. A reversal is the exact negation of the row it reverses. `due = Σ amountRupees` over all of a broker's rows. Negative due is shown as **"Advance ₹X"**.
- The ledger is append-only. Payments are never edited, only reversed. Earnings change only through a weight correction (F3). Hard delete is the only thing that removes rows (Ruling 13).
- Earnings are fixed at dispatch (client answer #24). F4 never recomputes a past earning from current order rates.
- Payment: `paidRupees` 1…100,000,000. `tdsRupees` 0…`paidRupees`. Modes `neft | upi | cash | cheque`. UTR (4–30 letters/digits) is required for NEFT and UPI. `paidOn` is an IST date, not in the future and not more than 365 days back.
- Who: ledger and dues reads need `money.view`. Payments and reversals need `broker.pay`. Reports need `reports.view`. All three are owner and city staff only. Plant head and supervisor get **403** on every money and report route and never see a money key anywhere (`MONEY_KEYS` gains every new money field; the contract leak test covers ledger and report payloads).
- Every write carries an `Idempotency-Key`. Payment and reverse routes are `idempotent: true, transactional: true`; a retry never creates a second payment (§5.7).
- Dates in report filters and ledger grouping are IST calendar dates (`YYYY-MM-DD`, inclusive ranges). A truck belongs to the IST day of its gross `capturedAt` (its `dispatchedAt`).
- Display follows the viewer's unit basis (§5.6). Exports use the exporting user's basis and label every quantity and rate column with its unit ("Net (MT)" / "Net (kg)", "Rate (₹/MT)" / "Rate (₹/kg)"). A broker statement goes to an outside party, so it uses the tenant's `externalUnitBasis`. Rupee amounts are the same number in both bases.
- Exports are generated on the device from report JSON. There is no export endpoint (Ruling 1).
- Copy comes from the boards named above. Where a board has no copy, the copy given in this plan is final.

## Rulings (decided while planning: conflicts and gaps)

1. **No `POST /reports/:kind/export`.** §7 lists it, but §8.5 (later and more specific) says files are built on the device. F4 ships only `GET /v1/reports/:kind`.
2. **Notifications stay activity-only in F4.** Recording or reversing a payment writes an activity entry (`entityType: 'broker'`, actions `broker.payment_recorded` / `broker.payment_reversed`, meta: amount, mode). The WhatsApp "broker payment" message (§8.6) goes to the log-only `Notifier` in B4. The notifications list and local push simulation are F5 (§12).
3. **Broker statement** (decisions §5 Default: "monthly WhatsApp PDF statement"). Board 06's **Statement** action opens a sheet. The user picks a month (this month, last month, or any earlier month of this and the last financial year), and the phone builds a PDF in the tenant's `externalUnitBasis` and opens the share sheet, from which the user chooses WhatsApp. There is no automatic monthly send in F4; a scheduled one would come after B4.
4. **Earning breakdown keeps commission and overprice apart** (store v5). Each breakdown line becomes `{ orderLineId, netKg, perMt, commissionPerMt, overpricePerMt }`, filled at dispatch and copied from the reversed row on a weight correction. That lets the ledger caption read "24.180 MT × (₹150 + ₹300 overprice)" (board 06) and lets broker-wise split commission and overprice. Broker-wise `commissionRupees = roundHalfUpSigned(Σ netKg × commissionPerMt, 1000)` over the broker's breakdown lines in range, and `overpriceRupees = earnedRupees − commissionRupees`, so the columns always add up to the ledger. A reversal counts on its own date (a November correction of an October truck lowers November's earned).
5. **Payment rules** are as in Global Constraints. Overpayment is allowed and becomes an advance. A payment to an inactive broker is allowed (settling a broker who stopped working). Cheque and cash may carry an optional reference in the same `utr` field ("Cheque no." hint for cheque). TDS is a field the canvas lacks; it goes under the date row as "TDS deducted (optional)".
6. **Reversing a payment:** owner and city staff (`broker.pay`), reason 3–200 characters. Only payment rows can be reversed (`NOT_REVERSIBLE` 409). Each can be reversed once (`ALREADY_REVERSED` 409). The reversed payment stays in the list with a "Reversed" badge.
7. **"On X MT dispatched and not yet paid"** (board 06) is FIFO. Live payments (not reversed) settle live earnings (not reversed) oldest first. A partly covered earning counts `roundHalfUp(uncovered × netKg, earning)` kg. At due ≤ 0 the caption is "All paid" (due 0) or "Paid ahead of earnings" (advance).
8. **Where the ledger lives.** A broker's party detail *is* board 06 for money roles: `PartyDetailScreen` renders `BrokerProfileScreen` when `type === 'broker'`. More → **Broker ledger** opens a dues list (`/brokers`; no board, so it uses the Parties list row style of board 18). Each row shows name, city and "₹X due" / "Advance ₹X" / "Nothing due", sorted by due descending. The More row's value is `formatRupeesShort(totalDueRupees) + ' due'`, or "Nothing due".
9. **Reports.** There are seven kinds, with URL slugs: `dispatch-register`, `pending-orders`, `unit-sales`, `broker-wise`, `customer-wise`, `product-wise`, `loading-variance`. They show as the canvas's six tiles plus a seventh, "Over / under loading" · "Planned vs net per truck" (spec §8.5 lists it, the canvas omits it). The canvas name "Unit-wise sales" wins over "company-wise" in the UI. The default range is month to date (IST). Presets: Today · Yesterday · This month · Last month · This financial year · Custom. Rules: `to ≥ from`; at most 366 days; `to` not after today. **Pending orders ignores the range** ("as of now"). Its age is whole IST days since the order was created, and its buckets come from `agedOrderDays` (default 10): `0–5`, `6–10`, `11–20`, `21+` (½×, 1×, 2× the setting). The dispatch register has one row per truck line, priced at the **billed rate** (`rate + overprice`, decisions Q10 Default), with the loading slip number for the Tally hand-off. Each report returns at most 5,000 rows plus a `truncated` flag.
10. **Dates are picked with a pure-JS `CalendarSheet`** (month grid, IST, days after `max` disabled). There is no native date picker, which keeps Expo Go untouched. The payment date and the custom report range both use it.
11. **SheetJS 0.20.3 from `cdn.sheetjs.com`.** The npm `xlsx` package is frozen at 0.18.5 with published advisories. The tarball URL is pinned in `package.json` and the lockfile. xlsx bytes come from `XLSX.write(wb, { type: 'array', bookType: 'xlsx' })` and are written as a `Uint8Array` with `new File(Paths.cache, name).write(bytes)` (expo-file-system's current API; check against the installed SDK 58 docs before coding).
12. **Report "Share" button** (board 23, third button) opens the system share sheet (`Share.share` from react-native) with a short text summary in the viewer's basis, for example "Dispatch register · 1 – 17 Nov 2026 · 962.400 MT · 41 trucks". "Excel" and "PDF" each build their file and open the share sheet with it.
13. **Hard delete keeps payments.** Payments are not tied to a truck, so deleting an order removes its earnings (F3 behaviour) and the broker's due may turn into an advance. The delete preview already counts ledger rows; nothing changes there.
14. **F3 carry-over (Task 9):**
    - (a) Hard delete writes tombstones with `reason: 'deleted'`, and `TasksPage` gains `deleted: id[]`. The phone marks every non-`sending`, non-`accepted` outbox row of those trucks `resolved`: the owner erased the order on purpose, so nothing is waiting any more.
    - (b) Restore returns `warnings?: ('VEHICLE_BUSY' | 'OVER_ASSIGNABLE')[]`, computed as on assign when it reinstates a cancelled truck, and Needs attention shows them.
    - (c) The dev-only `ROUTE_NAMES_CHANGED` LogBox on a supervisor → owner switch gets a failing test first and is fixed in `freshStart`.
    - (d) `PATCH /v1/orders/:id`, short-close, reopen, move-quantity and `DELETE /v1/orders/:id` become `idempotent: true`.
    - (e) A cursorless pull returns `resolved` and `deleted` only for the last 30 days (`RESOLVED_HORIZON_MS`). A cursorless pull only happens on a fresh device store, which has no outbox rows to resolve.

## Review Focus

1. **Record payment is retried after the server committed it** (network drop on the response, or a double tap). The second request replays the same response under the same key: one payment row, and the due drops once. The phone reuses the key until the request is answered (`useSubmitKey`). (Task 4 contract + Task 6 test)
2. **A plant head or supervisor reaches money by any path** (deep link `/brokers`, `/reports`, a broker's party page, direct API calls). Every ledger, dues, statement, payment, reverse and report route is 403, the routes redirect, and the More menu shows no money rows. (Task 4 + Task 5 contract, Task 6 + Task 8 tests)
3. **Money already paid, then the earning underneath changes.** A weight correction from 24.180 to 22.000 MT lowers the due by exactly ₹981. A hard delete of a paid order leaves the payment, and the due shows "Advance ₹X". The FIFO unpaid MT never goes negative. (Task 1 unit + Task 4 contract)
4. **A kg-basis user exports, and a broker statement goes out.** The user's export has "Net (kg)" whole numbers and "Rate (₹/kg)" to 3 decimals, with amounts identical to the MT export. The statement is in MT (`externalUnitBasis`) even when the sender uses kg. (Task 7 test)
5. **A truck dispatched at 23:50 IST on 31 Oct** (18:20Z) counts in October's report and statement, not November's. A range with `to < from`, over 366 days, or ending after today is a 422. A range with no trucks shows the empty state and the export buttons are disabled; nothing crashes. (Task 2 unit + Task 5 contract + Task 8 test)

---

### Task 1: Shared ledger rules

**Files:**
- Create: `packages/shared/src/rules/ledger.ts`, `packages/shared/src/rules/ledger.test.ts`
- Modify: `packages/shared/src/rules/trucks.ts` (+ `trucks.test.ts`), `packages/shared/src/rules/money.ts` (+ `money.test.ts`), `packages/shared/src/rules/index.ts`

**Interfaces:**
- Produces:
  - `roundHalfUpSigned(numerator: number, denominator: number): number`: `sign(n) × roundHalfUp(|n|, d)`, so halves round away from zero. Lives in `money.ts`.
  - `EarningLine = { orderLineId: string; netKg: number; perMt: number; commissionPerMt: number; overpricePerMt: number }`. `truckEarning(...)` keeps its signature and returns `breakdown: EarningLine[]`.
  - `earningFromRates(allocations: { orderLineId: string; netKg: number }[], rates: ReadonlyMap<string, { commissionPerMt: number; overpricePerMt: number }>): { earningRupees: number; breakdown: EarningLine[] }`. `truckEarning` delegates to it, and the mock's `rewriteEarning` uses it (Task 3).
  - `PAYMENT_MODES = ['neft', 'upi', 'cash', 'cheque'] as const`; `type PaymentMode`; `UTR_REQUIRED: ReadonlySet<PaymentMode>` = neft, upi; `PAYMENT_MODE_LABEL: Record<PaymentMode, string>` = NEFT, UPI, Cash, Cheque.
  - `LedgerRow = { id: string; kind: 'earning' | 'payment' | 'reversal'; amountRupees: number; netKg: number; entryDate: string; createdAt: string; reversesId: string | null }`. Here `netKg` is the Σ of the breakdown (0 for payments, negative for an earning's reversal). `entryDate` is the IST date: `paidOn` for payments and the payment's reversal date for its reversal, the IST date of `createdAt` otherwise.
  - `paymentAmount(paidRupees: number, tdsRupees: number): number` → `−(paid + tds)`.
  - `brokerDue(rows: readonly LedgerRow[]): number`.
  - `dueAfterPayment(dueRupees: number, paidRupees: number, tdsRupees: number): number`.
  - `halfOf(dueRupees: number): number` → `roundHalfUp(due, 2)` for due > 0, else 0.
  - `dueState(dueRupees: number): { kind: 'due' | 'advance' | 'clear'; rupees: number }`, where `rupees` is always ≥ 0.
  - `unpaidKg(rows: readonly LedgerRow[]): number` (Ruling 7; orders rows by `entryDate`, then `createdAt`, then `id`).
  - `monthTotals(rows: readonly LedgerRow[], month: string /* YYYY-MM */): { earnedRupees: number; paidRupees: number }`. Earned is earnings plus earning reversals in the month. Paid is `−(payments + payment reversals)` in the month.
  - `statementTotals(rows: readonly LedgerRow[], from: string, to: string): { openingDueRupees: number; earnedRupees: number; paidRupees: number; closingDueRupees: number; inRange: LedgerRow[] }`, with `inRange` ascending.
  - `isLiveRow(rows, row): boolean` (no reversal points at it).

- [ ] **Step 1: Write the failing tests** (`ledger.test.ts`, plus additions to `money.test.ts` and `trucks.test.ts`)

```ts
const A = earning('a', 10_881, 24_180, '2026-11-01'); // 24.180 MT × (₹150 + ₹300)
const B = earning('b', 4_518, 30_120, '2026-11-02');  // 30.120 MT × ₹150
const P = payment('p', paymentAmount(10_000, 500), '2026-11-03'); // −10,500
it('due is the signed sum: 15,399 − 10,500 = 4,899', () => expect(brokerDue([A, B, P])).toBe(4_899));
it('FIFO unpaid: A is ₹381 short → 847 kg, B unpaid 30,120 → 30,967', () => expect(unpaidKg([A, B, P])).toBe(30_967));
it('an advance leaves 0 unpaid kg, never negative', () => expect(unpaidKg([A, payment('q', -20_000, '2026-11-03')])).toBe(0));
it('a reversed payment no longer settles anything', () => {
  expect(unpaidKg([A, B, P, reversal('r', P, '2026-11-04')])).toBe(54_300);
});
it('canvas: due ₹86,400, pay ₹40,000 → ₹46,400; Half of 86,400 / 86,401', () => {
  expect(dueAfterPayment(86_400, 40_000, 0)).toBe(46_400);
  expect(halfOf(86_400)).toBe(43_200);
  expect(halfOf(86_401)).toBe(43_201);
  expect(halfOf(-5)).toBe(0);
});
it('dueState: −4,601 → advance 4,601; 0 → clear', () => { … });
it('monthTotals Nov: earned 15,399, paid 10,500', () => { … });
it('statement 1–30 Nov with an October earning: opening = October due', () => { … });
it('weight correction in Nov of an Oct truck lowers Nov earned (reversal counts on its date)', () => { … });
```

- `money.test.ts`: `roundHalfUpSigned(-1_500, 1_000)` → `-2`; `roundHalfUpSigned(1_499, 1_000)` → `1`; `roundHalfUpSigned(0, 7)` → `0`.
- `trucks.test.ts`: the canvas earning's breakdown is `[{ orderLineId: 'l1', netKg: 24_180, perMt: 450, commissionPerMt: 150, overpricePerMt: 300 }]`. `earningFromRates` with the same rates gives ₹10,881. Correcting to 22,000 kg at those rates gives ₹9,900.

- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/shared exec vitest run src/rules`
- [ ] **Step 3: Implement** `ledger.ts`, `roundHalfUpSigned`, and `earningFromRates`, with `truckEarning` delegating to it.
- [ ] **Step 4: Run, expect PASS**, then run `pnpm --filter @tonnage/shared typecheck` and `pnpm --filter @tonnage/mock-api test` (F3 earning tests must still pass with the wider breakdown).
- [ ] **Step 5: Commit** `feat(shared): ledger rules: due, payment sign, FIFO unpaid, statement, split earning breakdown`

---

### Task 2: Shared report aggregation

**Files:**
- Create: `packages/shared/src/reports/facts.ts` (fact types + `ReportFilter`), `packages/shared/src/reports/dates.ts`, `packages/shared/src/reports/aggregate.ts`, `packages/shared/src/reports/aggregate.test.ts`, `packages/shared/src/reports/index.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `roundHalfUp`, `roundHalfUpSigned`, `billedRate`, `pending`, `istDateParts`, `LedgerRow`, `brokerDue`.
- Produces:
  - `REPORT_KINDS = ['dispatch-register', 'pending-orders', 'unit-sales', 'broker-wise', 'customer-wise', 'product-wise', 'loading-variance'] as const`; `type ReportKind`.
  - `REPORT_ROW_CAP = 5_000`, `REPORT_MAX_DAYS = 366`.
  - Facts:
    - `TruckLineFact { truckId, dispatchedAt, companyId, companyCode, companyName, plantId, plantName, orderId, orderNumber, subOrderNumber, customerId|null, customerName|null, brokerId|null, brokerName|null, vehicleNo, loadingSlipNo, productId, productName, sizeLabel, lengthValue, lengthUnit, plannedKg, netKg, ratePerMt, overpricePerMt }`, one per dispatched truck line, where `plannedKg` is the truck's plan for that line.
    - `OpenSubOrderFact { subOrderId, orderId, subOrderNumber, companyId, companyCode, customerId|null, customerName|null, createdAt, orderedKg, dispatchedKg, pendingKg }`, for non-terminal sub-orders.
    - `BookedLineFact { orderId, createdAt, companyId, customerId|null, customerName|null, orderedKg, valueRupees }`, for non-draft orders.
    - `BrokerFact { brokerId, brokerName, rows: (LedgerRow & { earningLines: EarningLine[] })[] }`.
    - `ReportFacts { truckLines, openSubOrders, bookedLines, brokers }`.
  - `ReportFilter { from: string; to: string; today: string; agedOrderDays: number; companyId?: string; customerId?: string; brokerId?: string; plantId?: string; bucket?: AgeBucket }`.
  - `dates.ts`:
    - `istDate(at: string | number): string` (`YYYY-MM-DD`);
    - `inRange(date: string, from: string, to: string): boolean`;
    - `checkRange(from: string, to: string, today: string): 'ok' | 'ORDER' | 'TOO_LONG' | 'FUTURE'`;
    - `ageDays(createdAt: string, today: string): number`;
    - `AGE_BUCKETS = ['0–5', '6–10', '11–20', '21+']` as labels, with `ageBucket(days: number, agedOrderDays: number): AgeBucket`, where the edges are `⌊aged/2⌋`, `aged` and `2×aged`;
    - `monthOf(date: string): string`.
  - `variancePercentTenths(diffKg: number, plannedKg: number): number | null`: `roundHalfUpSigned(diffKg × 1000, plannedKg)`, or null when `plannedKg = 0`. The app shows tenths of a percent.
  - Aggregators, each `(facts: ReportFacts, f: ReportFilter) => ReportOf<K>` and each returning `{ kind, from, to, rows, truncated, summary }`:
    - `dispatchRegister`: rows `{ truckId, date, companyCode, orderNumber, subOrderNumber, customerName, brokerName, vehicleNo, loadingSlipNo, productName, lengthValue, lengthUnit, netKg, billedRate, valueRupees }`, where `valueRupees = roundHalfUp(netKg × billedRate, 1000)`, sorted by date then slip number. Summary `{ netKg, trucks, overUnderKg, valueRupees, byCompany: { companyId, companyCode, companyName, netKg, trucks }[] }`. Filters: company, customer, broker.
    - `pendingOrders`: rows `{ subOrderId, orderId, subOrderNumber, companyCode, customerName, createdAt, ageDays, bucket, orderedKg, dispatchedKg, pendingKg }` (pending > 0 only), oldest first. Summary `{ pendingKg, subOrders, byBucket: { bucket, pendingKg, count }[] }`. Filters: company, bucket. The range is ignored.
    - `unitSales`: rows by company × product `{ companyId, companyCode, companyName, productId, productName, netKg, valueRupees, trucks }`. Summary `{ netKg, valueRupees, byCompany }`.
    - `brokerWise`: rows `{ brokerId, brokerName, netKg, commissionRupees, overpriceRupees, earnedRupees, paidRupees, dueRupees }` (Ruling 4; `dueRupees` = closing due at `to`). Filter: broker.
    - `customerWise`: rows `{ customerId, customerName, bookedKg, bookedValueRupees, liftedKg, liftedValueRupees }`, where booked counts orders created in range and lifted counts trucks dispatched in range. Filters: customer, company.
    - `productWise`: rows `{ productId, productName, sizeLabel, lengthValue, lengthUnit, netKg, trucks }`. Filter: company.
    - `loadingVariance`: rows `{ truckId, date, plantName, vehicleNo, subOrderNumber, plannedKg, netKg, diffKg }` per truck (lines summed). Summary `{ trucks, overTrucks, underTrucks, overKg, underKg }`. Filter: plant.
  - `buildReport(kind: ReportKind, facts: ReportFacts, f: ReportFilter): Report`, which dispatches to the above.

- [ ] **Step 1: Write the failing tests** (`aggregate.test.ts`, hand-built facts):
  - `istDate('2026-10-31T18:20:00Z')` → `'2026-10-31'` and `istDate('2026-10-31T18:30:00Z')` → `'2026-11-01'`. The 23:50 IST truck is in an October register and absent from a November one (**Review Focus 5**).
  - Register value: 24,100 kg at rate 46,305 + overprice 300 → `valueRupees` 1,123,181 (half up). 24,180 kg at 46,300 + 300 → 1,126,788.
  - Register summary: plans 24,000 + 30,000 and nets 24,180 + 29,700 → `overUnderKg` −120. Two companies → two `byCompany` rows. `companyId` filter → one.
  - `checkRange('2026-11-17', '2026-11-01', '2026-11-17')` → `'ORDER'`. 367 days → `'TOO_LONG'`. `to` = tomorrow → `'FUTURE'`.
  - `ageBucket(14, 10)` → `'11–20'`, `ageBucket(5, 10)` → `'0–5'`, `ageBucket(6, 10)` → `'6–10'`, `ageBucket(21, 10)` → `'21+'`. With `ageDays('2026-11-03T04:30:00Z', '2026-11-17')` = 14.
  - Broker-wise for A, B, P (Task 1): commission 8,145, overprice 7,254, earned 15,399, paid 10,500, due 4,899, netKg 54,300.
  - `variancePercentTenths(180, 24_000)` → `8` (+0.8 %), `variancePercentTenths(-420, 24_000)` → `-18`, `variancePercentTenths(5, 0)` → `null`.
  - The cap: 5,001 truck lines → 5,000 rows, `truncated: true`, and the summary still counts all 5,001.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/shared exec vitest run src/reports`
- [ ] **Step 3: Implement.** Aggregate with integer sums only. Round each row once and compute summary sums from the unrounded components where the spec allows (register `valueRupees` total = Σ row values, because those are the Tally amounts).
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter @tonnage/shared typecheck`.
- [ ] **Step 5: Commit** `feat(shared): report aggregation over facts, IST ranges, age buckets, variance`

---

### Task 3: Shared schemas, errors and money keys; mock store v5 with payments

**Files:**
- Create: `packages/shared/src/schemas/money.ts`, `packages/shared/src/schemas/reports.ts` (+ `money.test.ts`, `reports.test.ts`), `packages/mock-api/src/ledger-views.ts`
- Modify: `packages/shared/src/schemas/index.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/redact.ts` (+ test), `packages/shared/src/index.ts`, `packages/mock-api/src/store.ts` (`SNAPSHOT_VERSION = 5`), `packages/mock-api/src/dispatch.ts`, `packages/mock-api/src/seed-orders.ts`, `packages/mock-api/src/dispatch.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 types.
- Produces (schemas, plus inferred types with the same name minus `Schema`):
  - `ledgerEntrySchema { id, kind: 'earning'|'payment'|'reversal', amountRupees, entryDate, createdAt, createdBy: ref, truck: { truckId, vehicleNo, orderId, orderNumber, subOrderNumber, netKg } | null, earningLines: { productName, netKg, commissionPerMt, overpricePerMt }[], payment: { mode, utr: string|null, paidRupees, tdsRupees, paidOn } | null, reversesId: string|null, reversedById: string|null, note: string|null }`.
  - `brokerLedgerSchema { broker: { id, name, city, defaultCommissionPerMt: number|null, active }, summary: { dueRupees, unpaidKg, month, earnedThisMonthRupees, paidThisMonthRupees }, items: ledgerEntry[], nextBefore: string|null }`, with query `ledgerQuerySchema { view: 'all'|'earnings'|'payments' = 'all', before?: string, limit: 1–100 = 50 }`.
  - `brokerDuesSchema { totalDueRupees, items: { brokerId, name, city, active, dueRupees, lastEntryAt: string|null }[] }`.
  - `recordPaymentBodySchema { paidRupees: int 1–100,000,000, tdsRupees: int ≥ 0 = 0, mode: enum PAYMENT_MODES, utr: string|null, paidOn: /^\d{4}-\d{2}-\d{2}$/ }`, with refinements: `tdsRupees ≤ paidRupees` (path `tdsRupees`); `utr` trimmed to 4–30 `[A-Za-z0-9]`, required when `UTR_REQUIRED.has(mode)` (path `utr`). The future / 365-day check of `paidOn` is the handler's, since it needs the clock (422 path `paidOn`).
  - `paymentResultSchema { entry: ledgerEntry, dueRupees }`; `reverseEntryBodySchema { reason: string 3–200 }`.
  - `brokerStatementSchema { broker, from, to, openingDueRupees, earnedRupees, paidRupees, tdsRupees, closingDueRupees, items: ledgerEntry[] }`, with query `{ from, to }` (an IST date range, `checkRange` rules).
  - `reportQuerySchema { from, to, companyId?, customerId?, brokerId?, plantId?, bucket? }`, plus `reportSchema` = a discriminated union on `kind` matching Task 2's outputs exactly (strict).
- Errors: add `NOT_REVERSIBLE`, `ALREADY_REVERSED` (409). Range errors are `VALIDATION` with `details` paths `from` / `to`.
- `MONEY_KEYS` += `commissionRupees`, `overpriceRupees`, `earnedRupees`, `paidRupees`, `dueRupees`, `totalDueRupees`, `openingDueRupees`, `closingDueRupees`, `earnedThisMonthRupees`, `paidThisMonthRupees`, `bookedValueRupees`, `liftedValueRupees`, `perMt`, `payment`, `earningLines`. The ledger's per-line field is `earningLines`, never `lines`: order schemas already use `lines` for sub-order lines that plant heads must keep.
- Store v5:
  - `BrokerLedgerRec` becomes `{ …F3 fields, kind: 'earning'|'payment'|'reversal', truckId: string|null, breakdown: EarningLine[], mode: PaymentMode|null, utr: string|null, tdsRupees: number|null, paidRupees: number|null, paidOn: string|null, note: string|null }`.
  - `writeEarning` and `rewriteEarning` produce the split breakdown (`rewriteEarning` uses `earningFromRates` with the reversed row's commission/overprice per line).
  - `ledger-views.ts`: `ledgerRows(state, brokerId): LedgerRow[]`; `toLedgerEntry(state, rec): LedgerEntry`; `brokerSummary(state, brokerId, today): BrokerLedger['summary']`.
- Seed (`seedOrders: true`): R.K. Agarwal gets one NEFT payment, "UTR 223614", recorded by Rajesh yesterday, of half his seeded earnings rounded down to ₹1,000. Mittal Brokers gets none.

- [ ] **Step 1: Failing tests:**
  - `recordPaymentBodySchema` refuses NEFT with `utr: null` (path `utr`), refuses `tdsRupees: 501` with `paidRupees: 500`, and accepts cash with `utr: null`.
  - `reportSchema` refuses an extra key.
  - `redactForRole('plant_head', { dueRupees: 1, earningLines: [], payment: {} })` → `{}`.
  - `dispatch.test.ts`: a dispatched canvas truck's earning row has the split breakdown; a correction's new row keeps commission 150 / overprice 300; a v4 snapshot is discarded on load.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/shared exec vitest run && pnpm --filter @tonnage/mock-api exec vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, then the whole contract suite (F3 suites unchanged): `pnpm --filter @tonnage/contract-tests test`; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(shared,mock-api): ledger, payment and report schemas; store v5 with payment rows`

---

### Task 4: Ledger API: dues, ledger, statement, payments, reversal

**Files:**
- Create: `packages/mock-api/src/handlers/brokers.ts`, `packages/contract-tests/src/suites/ledger.contract.ts`
- Modify: `packages/mock-api/src/router.ts`, `packages/contract-tests/src/index.ts` (`CONTRACT_SUITES` += `ledger` after `rejections`)

**Interfaces:**
- Consumes: Task 3 schemas and views; `brokerDue`, `statementTotals`, `paymentAmount` (Task 1).
- Produces routes. The broker must be a party of type `broker` in the caller's tenant; anything else is 404.
  - `GET /v1/brokers/dues` (`money.view`) → `BrokerDues`: every broker with a ledger row or `active`. `totalDueRupees` = Σ of positive dues.
  - `GET /v1/brokers/:id/ledger?view&before&limit` (`money.view`) → `BrokerLedger`, newest first by (`entryDate`, `createdAt`, `id`). `before` is the opaque cursor of the last item. `earnings` = earning rows and their reversals; `payments` = payment rows and their reversals. The summary always covers all rows; `month` is the current IST month.
  - `GET /v1/brokers/:id/statement?from&to` (`money.view`) → `BrokerStatement`, items ascending.
  - `POST /v1/brokers/:id/payments` (`broker.pay`, `idempotent: true`, `transactional: true`) → 201 `PaymentResult`. It appends a `payment` row with `amountRupees = paymentAmount(paid, tds)` and writes activity `broker.payment_recorded`.
  - `POST /v1/ledger/:id/reverse` (`broker.pay`, idempotent, transactional) `{ reason }` → 201 `PaymentResult` (the reversal entry and the new due). Only a live payment row can be reversed: an earning or reversal row → `NOT_REVERSIBLE`; an already-reversed payment → `ALREADY_REVERSED`. The reason is stored as the reversal's `note`. Activity `broker.payment_reversed`.

- [ ] **Step 1: Failing contract tests** (`ledger.contract.ts`). Setup: Rajesh books order 1 (R.K. Agarwal, commission 150, one line with overprice 300) and order 2 (same broker, no overprice). `fixtures.addTruck` dispatches 24,180 kg and 30,120 kg.
  - Ledger: due 15,399, unpaid 54,300 kg, two earning items, and the first item's `earningLines` = `[{ netKg: 24_180, commissionPerMt: 150, overpricePerMt: 300, … }]`.
  - Payment NEFT ₹10,000 + TDS ₹500, UTR 223614, today → 201, entry `amountRupees` −10,500, `dueRupees` 4,899. The ledger summary shows `unpaidKg` 30,967 and `paidThisMonthRupees` 10,500.
  - **Review Focus 1:** the same body and key again gives an identical response with `idempotent-replay: true`, and the ledger still has one payment.
  - 422s: NEFT without UTR (path `utr`); `paidOn` tomorrow (path `paidOn`); `tdsRupees > paidRupees`.
  - Reverse that payment with reason "Wrong UTR" → +10,500 and due 15,399. Reversing it again → 409 `ALREADY_REVERSED`. Reversing an earning → 409 `NOT_REVERSIBLE`. Reason "ok" → 422.
  - Overpay ₹20,000 → `dueRupees` −4,601.
  - **Review Focus 3:** with a ₹10,000 NEFT payment recorded, owner corrects truck 1 to net 22,000 → due falls by exactly 981. Hard-deleting order 1 → its earnings are gone, the payment stays, and the due is 4,518 − 10,000 = −5,482.
  - `GET /v1/brokers/dues` sums only positive dues.
  - Statement for 1st of the month → today: opening 0, closing = due, items ascending.
  - **Review Focus 2:** Kiran (plant head) and Ravi (supervisor) get 403 on all five routes. Priya (city staff) can record and reverse. A customer's id → 404. Another tenant's broker (`fixtures.createTenant`) → 404.
  - Activity entries `broker.payment_recorded` and `broker.payment_reversed` exist with `entityType: 'broker'`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @tonnage/contract-tests exec vitest run -t "ledger"`
- [ ] **Step 3: Implement** `handlers/brokers.ts`.
- [ ] **Step 4: Run all contract and mock tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(mock-api): broker dues, ledger, statement, payments and reversal`

---

### Task 5: Reports API

**Files:**
- Create: `packages/mock-api/src/report-facts.ts`, `packages/mock-api/src/handlers/reports.ts`, `packages/contract-tests/src/suites/reports.contract.ts`
- Modify: `packages/mock-api/src/router.ts`, `packages/contract-tests/src/index.ts` (`CONTRACT_SUITES` += `reports`)

**Interfaces:**
- Consumes: `buildReport`, `checkRange`, `istDate`, `REPORT_KINDS` (Task 2); `ledgerRows` (Task 3); `orderMath`.
- Produces:
  - `reportFacts(state: MockState, tenantId: string, kind: ReportKind): ReportFacts`, which builds only the facts the kind needs.
  - `GET /v1/reports/:kind` (`reports.view`) → `Report`. An unknown kind is 404. `today` comes from the mock clock (IST) and `agedOrderDays` from tenant settings. `checkRange` failures are 422 `VALIDATION`, with `details` path `to` for ORDER / FUTURE and `from` for TOO_LONG.
  - The supervisor's Done today stays `GET /v1/supervisor/done-today` (F3); supervisors get 403 here.

- [ ] **Step 1: Failing contract tests** (`reports.contract.ts`, using the Task 4 world plus a KRM order):
  - Dispatch register for this month: one row per truck line, with `valueRupees` = `roundHalfUp(netKg × (rate + overprice), 1000)` and the right `loadingSlipNo`. `companyId` = KRM gives only KRM rows.
  - **Review Focus 5:** with the clock at `2026-10-31T18:20:00Z`, dispatch a truck, then move the clock to November. The October range includes it and the November range does not. `to < from` → 422; 367 days → 422; `to` tomorrow → 422.
  - Pending orders: an order created 14 days ago is in bucket `11–20`, and `bucket=0–5` excludes it.
  - Broker-wise: commission 8,145, overprice 7,254, earned 15,399, paid 10,500, due 4,899 (a ₹10,000 + ₹500 TDS payment).
  - Customer-wise: booked vs lifted kg and ₹. Product-wise: one row per product × length. Loading variance: plan 24,000, net 24,180 → `diffKg` 180.
  - **Review Focus 2:** Kiran and Ravi get 403 for every kind; `GET /v1/reports/unknown` → 404.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all contract and mock tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(mock-api): seven reports over shared aggregation`

---

### Task 6: Broker ledger screens and Record payment

**Files:**
- Create: `apps/mobile/src/api/hooks/money.ts`, `apps/mobile/src/screens/money/{BrokerDuesScreen,BrokerProfileScreen,DueCard,LedgerList,LedgerEntrySheet,RecordPaymentSheet,captions}.tsx|ts`, `apps/mobile/src/ui/CalendarSheet.tsx`, `apps/mobile/app/(app)/brokers.tsx`, `apps/mobile/test/money.test.tsx`
- Modify: `src/screens/MoreScreen.tsx` (the "Broker ledger" row goes live with its value; the "Reports" row goes live in Task 8), `src/screens/parties/PartyDetailScreen.tsx` (broker → `BrokerProfileScreen`), `src/api/hooks/trucks.ts` + `src/api/hooks/orders.ts` (`afterTruckChange` / `afterOrderChange` also invalidate `['broker']` and `['report']`), `src/screens/messages.ts` (`NOT_REVERSIBLE`: "Only payments can be reversed"; `ALREADY_REVERSED`: "This payment was already reversed"), `src/ui/index.ts`

**Interfaces:**
- Consumes: Task 4 routes; Task 1 `dueAfterPayment`, `halfOf`, `dueState`, `PAYMENT_MODE_LABEL`, `UTR_REQUIRED`; `useSubmitKey`; `toDisplayQty`, `toDisplayRate`, `formatRupees`, `formatRupeesShort`.
- Produces:
  - Hooks:
    - `useBrokerDues()` with key `['broker', 'dues']`;
    - `useBrokerLedger(id, view)` (infinite, `before` cursor) with key `['broker', id, 'ledger', view]`;
    - `useBrokerStatement(id, range)` with key `['broker', id, 'statement', from, to]`;
    - `useRecordPayment(id)` and `useReversePayment()`, both of which invalidate `['broker']` and `['report']` on success.
  - `ledgerCaption(e: LedgerEntry, basis: UnitBasis): string`:
    - one distinct rate with overprice: "24.180 MT × (₹150 + ₹300 overprice)";
    - no overprice: "30.120 MT × ₹150 commission";
    - kg basis: "24,180 kg × (₹0.150 + ₹0.300 overprice)";
    - several distinct rates: "54.300 MT · 2 rates";
    - payment: "UTR 223614 · recorded by Rajesh", with "· TDS ₹500" inserted after the UTR when TDS > 0;
    - reversal of an earning: "Weight corrected";
    - reversal of a payment: the reason.
  - `ledgerTitle(e)`: earning "SO-2611-0142 · CG 04 MK 2291"; payment "Payment · NEFT"; reversal "Payment reversed · NEFT" / "Weight corrected · SO-… · CG …".
  - `BrokerProfileScreen({ party })` (board 06):
    - Header: avatar initials, name, "Broker" badge, "Raipur · default ₹150 / MT".
    - Actions: Call · WhatsApp · Statement.
    - `DueCard`: "Due to broker" with the amount in amber (`wnt`), or "Advance" + amount in `okt`, or "₹0". Caption "On 212.400 MT dispatched and not yet paid", or the Ruling 7 copy. Below: "Earned in November" (green) and "Paid in November" (blue).
    - Contacts as F2.
    - "Ledger" with a segmented control All · Earnings · Payments and day groups "Today" / "Yesterday" / "3 Nov". Amounts: "+₹10,881" green, "−₹40,000" red. A reversed payment has a "Reversed" badge.
    - Footer: "Record payment" (only with `broker.pay`).
    - Tapping a payment row opens `LedgerEntrySheet` with the details and a danger "Reverse payment" action (reason ≥ 3 characters, button "Reverse ₹40,000").
  - `RecordPaymentSheet({ broker, dueRupees })` (board 33):
    - Title "Pay R.K. Agarwal", "Due now ₹86,400".
    - "Amount paid" with a big ₹ input in red. Chips "Full ₹86,400" and "Half", shown only while due > 0.
    - "Paid by" chips NEFT / UPI / Cash / Cheque.
    - "UTR / reference" (hint "Cheque no." for cheque) and "Date", which defaults to today and opens `CalendarSheet` with max = today.
    - "TDS deducted (optional)".
    - The green row reads "Due after this payment ₹46,400", or "Advance after this payment ₹X".
    - Button "Record ₹40,000 payment", disabled until valid. Inline errors: "UTR is needed for NEFT and UPI", "TDS can't be more than the amount".
    - Success → toast "Payment recorded", the sheet closes, and the due refreshes from the server.
  - `CalendarSheet({ value, max, onPick, onClose }: { value: string; max: string; onPick(date: string): void; onClose(): void })` (Ruling 10).
  - `BrokerDuesScreen` (Ruling 8): title "Broker ledger", rows from `useBrokerDues`, and an empty state "No brokers yet". Route `/brokers` is wrapped in `RequireAction action="money.view"`.

- [ ] **Step 1: Failing tests** (`money.test.tsx`, mock API; the world is built with `mock.fixtures` as in Task 4; time pinned with `jest.spyOn(Date, 'now')`):
  - Rajesh: More shows "Broker ledger" with "₹15,399 due" (short format below a lakh shows the full amount). Tapping it lists R.K. Agarwal, which opens his profile with "Due to broker", "₹15,399", "On 54.300 MT dispatched and not yet paid", and rows "+₹10,881" / "24.180 MT × (₹150 + ₹300 overprice)" and "30.120 MT × ₹150 commission".
  - Record payment: "Full ₹15,399" fills the amount. NEFT with an empty UTR disables the button and shows "UTR is needed for NEFT and UPI". Entering 10,000 + TDS 500 + UTR 223614 shows "Due after this payment ₹4,899" and "Record ₹10,000 payment". Saving gives "Payment recorded", and the due card shows ₹4,899.
  - **Review Focus 1:** arm a network failure for the next request (Demo controls) and press Record. The error shows; press Record again → one payment in the ledger.
  - Overpay ₹20,000 → the due card shows "Advance" and "₹4,601".
  - Reverse a payment with the reason "Wrong UTR" → the due is back and the row has "Reversed".
  - The kg basis caption reads "24,180 kg × (₹0.150 + ₹0.300 overprice)".
  - **Review Focus 2:** Kiran has no "Money & reports" group, and navigating to `/brokers` redirects. Priya can record a payment.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter mobile exec jest test/money.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter mobile lint && pnpm --filter mobile typecheck`.
- [ ] **Step 5: Commit** `feat(mobile): broker dues, broker profile and ledger, record and reverse payment`

---

### Task 7: Export kit and broker statement

**Files:**
- Create: `apps/mobile/src/exports/{table,xlsx,html,share}.ts`, `apps/mobile/src/screens/money/StatementSheet.tsx`, `apps/mobile/test/exports.test.ts`
- Modify: `apps/mobile/package.json` (`npx expo install expo-print expo-sharing expo-file-system`; SheetJS per Ruling 11), `apps/mobile/test/setup.ts` (jest mocks for `expo-print`, `expo-sharing`, `expo-file-system`), `BrokerProfileScreen` (Statement action)

**Interfaces:**
- Consumes: `Report` and `BrokerStatement` (Task 3), the unit and money formatters, `useTenantSettings()` (`externalUnitBasis`; `GET /v1/settings` is `self.view`, so city staff can read it).
- Produces:
  - `ExportColumn = { label: string; align: 'left' | 'right'; format: 'text' | 'date' | 'qty' | 'rate' | 'rupees' | 'int' | 'percentTenths' }`.
  - `ExportTable = { title: string; subtitle: string; fileStem: string; columns: ExportColumn[]; rows: (string | number | null)[][]; totals: (string | number | null)[] | null; footer: string }`. Quantities stay integer kg and rates stay ₹/MT inside the model; formatting happens per output.
  - `reportTable(r: Report, basis: UnitBasis, ctx: { generatedAt: number; by: string }): ExportTable`, with column labels per kind. For example, the dispatch register is `Date · Unit · Order · Customer · Vehicle · Product · Length · Net (MT) · Rate (₹/MT) · Amount (₹) · Slip`, and in kg basis "Net (kg)" / "Rate (₹/kg)". `fileStem` looks like `dispatch-register_2026-11-01_2026-11-17`. The footer reads "Generated 17 Nov 2026, 14:05 IST by Rajesh Agrawal".
  - `statementTable(s: BrokerStatement, basis: UnitBasis, ctx): ExportTable`: title "Statement · R.K. Agarwal", subtitle "1 – 30 Nov 2026". It starts with an "Opening due" row and ends with the "Closing due" totals.
  - `toXlsxBytes(t: ExportTable, basis: UnitBasis): Uint8Array` (SheetJS). Quantity cells hold `kg / 1000` with number format `0.000` in MT, or integer kg with `#,##0`. Rate cells hold ₹/MT as integers, or `/1000` with `0.000` in kg. Rupee cells are integers with `#,##0`. The header row is bold and the column widths are set.
  - `toHtml(t: ExportTable, basis: UnitBasis): string`: an A4 table, every text HTML-escaped, tabular numerals, the totals row in bold, and the footer.
  - `shareExport(t: ExportTable, kind: 'xlsx' | 'pdf', basis: UnitBasis): Promise<'shared' | 'unavailable'>`.
    - For `xlsx`: `new File(Paths.cache, stem + '.xlsx').write(bytes)`, then `Sharing.shareAsync(uri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: title })`.
    - For `pdf`: `Print.printToFileAsync({ html, width: 595, height: 842 })`, then `shareAsync(uri, { mimeType: 'application/pdf' })`.
    - When `Sharing.isAvailableAsync()` is false, it returns `'unavailable'` and the caller toasts "Sharing isn't available on this device".
  - `StatementSheet({ broker })` (Ruling 3): month chips, with this month as the default; "Share PDF" builds the statement in `externalUnitBasis` and shares it. A month with no rows still produces a statement showing the opening/closing due.

- [ ] **Step 1: Failing tests** (`exports.test.ts`, pure plus mocked expo modules):
  - The dispatch register MT labels are exactly as above. **Review Focus 4:** the kg labels are "Net (kg)" / "Rate (₹/kg)", and the "Amount (₹)" cells are identical in both bases.
  - `toXlsxBytes` read back with `XLSX.read`: the net cell is `{ v: 24.18, z: '0.000' }` in MT and `{ v: 24180 }` in kg, and the rupee cell is `1126788`.
  - `toHtml` escapes a customer named `<b>A&B</b>`.
  - `statementTable` for a kg-basis sender with `externalUnitBasis: 'mt'` has "Net (MT)" (**Review Focus 4**).
  - `shareExport(…, 'pdf')` calls `printToFileAsync` and then `shareAsync` with `mimeType: 'application/pdf'`. With sharing unavailable, it returns `'unavailable'` and never prints.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter mobile exec jest test/exports.test.ts`
- [ ] **Step 3: Implement.** Install the deps first and confirm that `npx expo-doctor` reports no SDK mismatch.
- [ ] **Step 4: Run, expect PASS**; lint and typecheck.
- [ ] **Step 5: Commit** `feat(mobile): on-device xlsx and PDF exports, broker statement`

---

### Task 8: Reports screen

**Files:**
- Create: `apps/mobile/src/api/hooks/reports.ts`, `apps/mobile/src/screens/reports/{ReportsScreen,ReportTiles,ReportPreview,RangeSheet,reportMeta}.tsx|ts`, `apps/mobile/app/(app)/reports.tsx`, `apps/mobile/test/reports.test.tsx`
- Modify: `src/screens/MoreScreen.tsx` (the "Reports" row goes live), `src/nav/` (the `/reports` route wrapped in `RequireAction action="reports.view"`)

**Interfaces:**
- Consumes: Task 5 route; Task 7 `reportTable` and `shareExport`; `useUnitFilter` (the "All units" chip opens the existing `UnitSwitcherSheet`); `CalendarSheet` (Task 6); `variancePercentTenths`, `checkRange` (Task 2).
- Produces:
  - `useReport(kind, f)` with key `['report', kind, companyId, from, to, extra]`, refetched on focus.
  - `REPORT_META: Record<ReportKind, { title: string; caption: string; icon: IconName; tone: Tone; emptyText: string }>`, with copy from board 23:
    - Dispatch register / "Every truck, net weight";
    - Pending orders / "Ageing by days";
    - Unit-wise sales / "MT and ₹ per company";
    - Broker-wise / "Earned, paid, due";
    - Customer-wise / "Booked vs lifted";
    - Product-wise / "Size and length mix";
    - Over / under loading / "Planned vs net per truck" (Ruling 9).
    - The empty texts are, for example, "No trucks dispatched in this period" and "No pending orders".
  - `RangeSheet`: presets Today · Yesterday · This month · Last month · This financial year · Custom (two `CalendarSheet` picks). It refuses ranges that fail `checkRange`, with the copy "Pick an end date on or after the start", "Pick at most 366 days" or "The end date can't be after today". The chip label is "1 – 17 Nov 2026".
  - `ReportsScreen` (board 23):
    - Title "Reports", a chip row (range · unit · the kind's own filter chip: "All customers" / "All brokers" / "All plants" / "All ages"), and the 2-column tile grid with the selected tile outlined.
    - `ReportPreview` card: title, range, and three stat tiles per kind. For the register these are "Dispatched" (qty, unit caption), "Trucks" ("this period") and "Over / under" (signed qty, "MT net"). Then a company colour bar and table (Unit · Net MT · Trucks · Total) for the register and unit sales, or the first 20 rows with "See all N rows" for the others. `truncated` shows "Showing the first 5,000 rows; narrow the range".
    - Buttons Excel · PDF · Share (Ruling 12), disabled when there are no rows.
    - Pending orders hides the range chip and shows "As of now".

- [ ] **Step 1: Failing tests** (`reports.test.tsx`, mock API, `Date.now` pinned to 17 Nov 2026 IST):
  - Rajesh: More → Reports. The chip reads "1 – 17 Nov 2026" and Dispatch register is selected with "Dispatched", "Trucks" and "Over / under". The KRM unit filter leaves only the "Kalinga · KRM" row.
  - Broker-wise shows earned, paid and due per broker.
  - Excel calls `shareExport` with `'xlsx'` and a table titled "Dispatch register".
  - The Custom range with end < start shows "Pick an end date on or after the start".
  - **Review Focus 5:** a range with no trucks shows "No trucks dispatched in this period", with Excel/PDF disabled.
  - The kg basis header reads "Net kg".
  - **Review Focus 2:** Priya sees Reports. Kiran has no Reports row, and `/reports` redirects. Ravi's tabs are unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; lint and typecheck.
- [ ] **Step 5: Commit** `feat(mobile): reports with ranges, unit filter, previews and exports`

---

### Task 9: F3 carry-over

**Files:**
- Modify:
  - `packages/mock-api/src/store.ts` (`TruckTombstoneRec.reason: 'gone' | 'deleted'`, which v5 already includes);
  - `handlers/order-lifecycle.ts` (`deleted` tombstones; `idempotent: true` on PATCH `/v1/orders/:id`, short-close, reopen, move-quantity, DELETE);
  - `handlers/supervisor.ts` (`deleted`, the 30-day horizon);
  - `handlers/rejections.ts` (restore `warnings`);
  - `packages/shared/src/schemas/trucks.ts` (`tasksPageSchema.deleted`, `restoreRejectionResultSchema.warnings`);
  - `apps/mobile/src/offline/deviceStore.ts` + `sqliteDeviceStore.ts` (`replaceTasks` resolves the rows of deleted trucks);
  - `apps/mobile/src/screens/attention/NeedsAttentionScreen.tsx` + `RejectionDetailSheet.tsx` (show warnings);
  - `apps/mobile/src/nav/freshStart.ts`;
  - the contract suites `sync.contract.ts`, `rejections.contract.ts`, `order-lifecycle.contract.ts`;
  - `apps/mobile/test/{device-store,attention,router}.test.ts(x)`.

**Interfaces:**
- Produces:
  - `TasksPage.deleted: string[]`;
  - `RESOLVED_HORIZON_MS = 30 × DAY` (mock, `supervisor.ts`);
  - `RestoreRejectionResult.warnings?: ('VEHICLE_BUSY' | 'OVER_ASSIGNABLE')[]`. The restore toast reads "Restored · CG 04 MK 2291 is also on another open truck" for VEHICLE_BUSY and "Restored · the plan is over what's left to assign" for OVER_ASSIGNABLE.

- [ ] **Step 1: Failing tests:**
  - (a) Contract: Ravi's TARE is rejected `TRUCK_CANCELLED` and the owner hard-deletes the order. Ravi's next pull (with cursor) lists the truck in `deleted` and not in `removed` only. Device store: a `rejected` and a `blocked` row of that truck become `resolved`, the `pending` count drops to 0, and a `sending` row is left alone.
  - (e) Contract: a rejection resolved 31 days ago is absent from a cursorless pull's `resolved`, and one resolved 29 days ago is present.
  - (b) Contract: the truck is cancelled, a replacement truck with the same vehicle is assigned, and the owner restores the rejection → `warnings: ['VEHICLE_BUSY']`. Attention test: the toast shows the copy above.
  - (c) `router.test.tsx`: switching person supervisor → owner through Demo tools with `console.error` / `console.warn` spied → no call mentioning `ROUTE_NAMES_CHANGED`, and the owner lands on Home.
  - (d) Contract, one case per route: the same `Idempotency-Key` twice → the second response is identical with `idempotent-replay: true`, there is one activity entry, and a versioned PATCH replay is not `STALE`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** For (c), use superpowers:systematic-debugging. Find which reset hands the router a state whose `routeNames` differ from the mounted navigator's, and fix it in `freshStart`; do not silence the warning.
- [ ] **Step 4: Run all tests, expect PASS.** `pnpm test`
- [ ] **Step 5: Commit** `fix(mock-api,mobile): F3 carry-over: deleted trucks resolve outbox rows, restore warnings, idempotent order writes, fresh start without route warning`

---

### Task 10: Docs, full verification, device walkthrough

**Files:**
- Modify: `CLAUDE.md` (F4 done; `src/screens/money/`, `src/screens/reports/`, `src/exports/`; ledger sign convention; reports via shared aggregation; Expo Go deps `expo-print`/`expo-sharing`/`expo-file-system` + SheetJS tarball; the seeded payment), `.superpowers/sdd/<run>/progress.md`

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test`: all green.
- [ ] **Step 2: Emulator walkthrough** (`npx expo start --localhost`, `adb reverse tcp:8081 tcp:8081`):
  - Rajesh: More → Broker ledger → R.K. Agarwal. Record a NEFT payment with TDS and check the due card and ledger. Reverse it.
  - Share a statement PDF and open it in the share target.
  - Reports: dispatch register month to date → Excel and PDF both open in a viewer with correct units. Switch the unit to KRM. Switch the basis to kg and export again.
  - As Ravi, weigh a truck offline and sync, then check that the broker's ledger shows the new earning.
  - As Kiran, check that no ₹ appears anywhere and that `/reports` and `/brokers` redirect.
  - Switch person supervisor → owner and check that no LogBox appears.
  - Repeat the ledger in dark theme.
- [ ] **Step 3: Commit** `docs: CLAUDE.md for F4`
