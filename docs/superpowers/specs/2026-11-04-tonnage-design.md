# Tonnage — System Design Spec

- **Date:** 2026-11-04 · **Status:** Approved design, awaiting written-spec review
- **Product:** Tonnage — order and dispatch for multi-company steel plants (Android app + API)
- **Sources of truth:**
  - Business rules: decisions register *"Tonnage — Decisions Needed to Build"* v0.2 (Claude Docs, `7f2fd784-5809-4ac7-ba0f-42a25abdba23`). Where it marks an item **Open**, this spec builds its **Default** and isolates it so the client's answer is cheap to apply.
  - UI: design canvas *"Tonnage Mobile — Android App Design"* (40 artboards, `1cf17fda-d3a4-498b-b46d-c67fdc49f795`). Where canvas and decisions register disagree, the register wins (see §11).

## 1. Goals, scope, non-goals

**Goal.** One owner's group of steel companies runs every order — booking, truck assignment, plant weighment, dispatch, broker commission and payment — on Android phones instead of Excel, with supervisors able to weigh trucks without network.

**Success criteria**
1. The six end-to-end use cases in §10.3 pass as automated scenario tests.
2. A supervisor can capture tare and gross with the phone offline; the data syncs automatically and is never silently lost.
3. No money field (rate, value, broker amount) is ever present in a response to a supervisor or plant head.
4. Lists load in < 1 s on 4G (excluding free-tier cold start).

**In scope (v1):** Android app (phone + responsive tablet), REST API, PostgreSQL, multi-tenant-ready data layer launched for one tenant, Excel import (parties, products), reports with Excel/PDF export, push notifications, notification outbox with log-only WhatsApp.

**Non-goals (v1) / future upgrades:** real OTP SMS (paused — dev provider only), WhatsApp Business sending, web panel, iOS, weighbridge auto-capture, Tally sync, credit limits/checks, custom roles, self-signup and SaaS billing, unplanned-truck offline capture (#26), HR features, e-way bill generation, material returns, rail dispatch, GST computation.

## 2. Architecture

```
apps/mobile ──HTTPS/JSON──▶ apps/api (Fastify) ──▶ PostgreSQL
   │  expo-sqlite (supervisor outbox)     │
   │                                      ├─ pg-boss worker (in-process on free tier):
   └◀── Expo Push ◀──────────────────────┘   notification outbox → push / WhatsApp(log) ; exports
packages/shared: zod schemas · rules/* (pure) · formatters · policy table · error codes
```

**Monorepo (pnpm workspaces)**
- `apps/mobile` — Expo (latest SDK), TypeScript, Expo Router, TanStack Query, Zustand, react-hook-form, expo-sqlite, expo-secure-store, expo-local-authentication, expo-notifications, expo-sharing.
- `apps/api` — Node + Fastify, Drizzle ORM + drizzle-kit migrations, pg-boss, pino, exceljs, pdfmake.
- `packages/shared` — zod request/response schemas, enums, pure business rules, formatters (MT, ₹ Indian grouping, L/Cr), `policy.ts`, error codes. Imported by both app and API so the maths is identical on both sides; the server is always authoritative.

**Environments:** local (Docker Postgres), `staging` (free tiers), `prod` (later). All config via env vars validated by zod at boot.

**Free-tier hosting (to verify current limits when planning M1):**

| Need | Choice | Accepted trade-off |
|---|---|---|
| Postgres | Neon free | Likely non-India region; small storage. Must move to an India region (or get client sign-off) before go-live. |
| API | Render free web service | Sleeps when idle; 30–60 s cold start. App uses 90 s sync timeout and a "Waking server…" state. |
| OTP | `DevOtpProvider` (fixed or logged code) | OTP is paused. API refuses to boot with the dev provider when `NODE_ENV=production`. |
| Push | Expo Push | — |
| WhatsApp | `Notifier` interface, log-only implementation | Open item #11. |
| Builds/OTA | EAS free tier; local `expo run:android` | Build queue waits. |
| Errors | Sentry free | — |

Everything is portable: plain Postgres, Dockerised API, each provider behind an interface.

## 3. Domain glossary

MT = metric tonne, always 3 decimals. **Tare** = empty truck weight; **gross** = loaded; **net** = gross − tare = the dispatched quantity (the only quantity that counts). **Company** = one legal entity / GSTIN / Tally billing unit. **Plant** = where a company loads trucks (child of company). **Sub-order** = one company's part of a customer order. **Basic rate**, **conversion** (₹/MT size extra per product), **overprice** (extra ₹/MT a broker asks to charge the customer, paid to the broker), **commission** (broker ₹/MT on dispatched net). **Short close** = stop the undispatched remainder. **LR** = lorry receipt. **Loading slip** = numbered slip issued at dispatch.

## 4. Data model

Conventions:
- Every table has `tenant_id`. Foreign keys are composite and include `tenant_id`, so cross-tenant references are impossible. Postgres RLS on `current_setting('app.tenant_id')`, set per transaction, is defence in depth.
- IDs are UUIDv7 (time-ordered; the phone can mint IDs offline).
- **Quantities are integer kilograms** (`bigint`, MT × 1000). **Money is integer rupees** (`bigint`). No floats anywhere.
- `created_at`, `updated_at`, `created_by` everywhere; `version int` on `orders`, `sub_orders`, `order_lines`, `trucks` for optimistic locking.
- Time: all business dates in Asia/Kolkata; financial year 1 Apr–31 Mar IST.

**Organisation & access**
- `tenants(id, name, settings jsonb)` — settings: `completionToleranceKg` (default 1000), `agedOrderDays` (10), `defaultPricing`, `allowHardDeleteAfterDispatch` (true), `externalUnitBasis` (`mt`), WhatsApp toggles, `orderNumberFormat`.
- `companies(id, code, name, gstin, order_prefix, active)`
- `plants(id, company_id, name, location, active)`
- `users(id, name, mobile unique-per-tenant, role ∈ owner|city_staff|plant_head|supervisor, active, invited_at, last_seen_at, preferences jsonb)` — `preferences.unitBasis ∈ mt|kg` (default `mt`, see §5.6).
- `user_plants(user_id, plant_id)` — plant head: 1..n; supervisor: exactly 1 (enforced).
- `refresh_tokens(id, user_id, device_id, hash, expires_at, revoked_at)`, `devices(id, user_id, push_token, app_version)`

**Masters**
- `parties(id, type ∈ customer|broker|transporter, name, gstin null, city, default_commission_per_mt null, payment_terms_text, is_self_transporter bool, active)` — unique GSTIN per tenant.
- `party_contacts(id, party_id, name, role_label)` → `contact_numbers(id, contact_id, number, label, whatsapp bool)`
- `party_addresses(id, party_id, kind ∈ bill_to|ship_to, label, address, is_default)` — exactly one bill-to.
- `products(id, category, grade, size_label, conversion_per_mt, standard_lengths jsonb, active)`; display name e.g. "TMT Fe500D · 12 mm".
- `product_companies(product_id, company_id)` — which companies make it.

**Orders**
- `orders(id, number, type ∈ customer_broker|customer|broker_only, customer_id null, broker_id null, commission_per_mt_snapshot, bill_to_id, ship_to_id, pricing_method ∈ direct|basic_conversion, basic_rate null, is_draft, draft_payload jsonb, created_by, version)`. Number is null while draft.
- `sub_orders(id, order_id, company_id, suffix 'A'|'B'…, closed_at, closed_by, close_kind ∈ short_close|cancel|tolerance null, close_reason, close_note, version)`. **Status is derived, never stored** (§5.3).
- `order_lines(id, sub_order_id, product_id, length_value, length_unit ∈ m|ft|mm, ordered_kg, basic_rate_snapshot null, conversion_snapshot null, rate, rate_edited bool, overprice_per_mt, closed_kg default 0, version)`

**Dispatch**
- `trucks(id, sub_order_id, plant_id, vehicle_no, transporter_id null, driver_name, driver_phone, lr_no null, state ∈ assigned|at_gate|loading|dispatched|cancelled, assigned_at/by, at_gate_at, tare_at, dispatched_at, cancelled_at/by, cancel_reason, loading_slip_no null, version)`
- `truck_load_plan(truck_id, order_line_id, planned_kg)`
- `weighments(id, truck_id, kind ∈ tare|gross, kg, entered_by, device_id, client_event_id unique, captured_at_device, captured_at, received_at, clock_skew_flag, slip_photo_url null, superseded_by null)`
- `truck_line_allocations(truck_id, order_line_id, net_kg)` — deferred constraint trigger: Σ net_kg = gross − tare.
- `weighment_rejections(id, client_event_id, truck_id, user_id, payload jsonb, code, server_state jsonb, status ∈ open|restored|dismissed, resolved_by, resolution_note)`

**Money**
- `broker_ledger(id, broker_id, kind ∈ earning|payment|reversal, truck_id null, amount_rupees signed, breakdown jsonb, mode ∈ neft|upi|cash|cheque null, utr null, tds_rupees null, paid_on null, reverses_id null, created_by)` — **append-only** (no updates; corrections = reversal + new row; hard delete is the only exception).

**Cross-cutting**
- `activity_log(id, entity_type, entity_id, order_id null, action, actor_id, meta jsonb, at)` — event log (who created/assigned/weighed/closed), not field-level diffs; hard delete removes it too.
- `notifications(id, user_id, kind, title, body, deep_link, read_at)`
- `notification_outbox(id, channel ∈ push|whatsapp, payload, status, attempts, sent_at)`
- `number_series(tenant_id, series_key, fy, next_value)` — row-locked counter.
- `idempotency_keys(key, user_id, route, response jsonb, created_at)` — 24 h retention.
- `import_jobs(id, kind, file_url, mapping jsonb, dry_run_result jsonb, status)`

## 5. Business rules

All rules are pure functions in `packages/shared/rules`, called by the API inside transactions and by the app for previews.

### 5.1 Quantities (per order line)

```
dispatched(l) = Σ allocation.net_kg over DISPATCHED trucks
closed(l)     = closed_kg (set at short close / tolerance close)
pending(l)    = max(0, ordered − dispatched − closed)
over(l)       = max(0, dispatched − ordered)
reserved(l)   = Σ planned_kg over trucks in assigned|at_gate|loading
assignable(l) = pending − reserved      (negative → warning, never blocks)
```

Pending is **per line, never netted across lines**: `pending(sub_order) = Σ pending(line)`.

**Completion tolerance (client answer #23, ±1 MT):** tenant setting `completionToleranceKg` = 1000.
- *Under:* when a truck dispatch leaves `pending(sub_order) ≤ tolerance` and the sub-order has no other open trucks, the same transaction sets each line's `closed_kg = pending(l)` and `close_kind = tolerance`, reason "Within tolerance". Status shows **Completed**.
- *Over:* over-dispatch stays allowed (no blocking). If `Σ over(l)` for a sub-order exceeds tolerance, it is flagged "+X MT over" and the owner is notified.

### 5.2 Truck state machine

```
ASSIGNED ──at-gate──▶ AT_GATE ──tare──▶ LOADING ──gross+split──▶ DISPATCHED
    │  (at-gate optional: ASSIGNED ──tare──▶ LOADING)
    └────────────── cancel (owner / city staff) from any non-terminal ──▶ CANCELLED
```

- **Gross and dispatch are one action** ("Save gross · mark dispatched"). There is no separate "gross weighed" state.
- **Net split:** single plan line → auto-allocated. Several lines → supervisor enters kg per line, prefilled pro-rata from the plan, must equal net exactly. Supervisor sees products and kg only.
- **Weight correction:** supervisor may correct tare until dispatch. After dispatch, owner only: the old weighment is superseded, allocations and that truck's ledger earning are reversed and rewritten using the truck's **original snapshot rates** and the new net, status re-derived, activity logged.
- **Plausibility:** net < 50 % or > 150 % of plan → second confirmation, never blocks. Net ≤ 0 → rejected.
- **Assignment guards:** sub-order not closed; customer present (broker-only orders blocked until a customer is added); every planned line belongs to the sub-order (blocks "product not on order"); company and plant active; same vehicle on another open truck → warning only; plan over assignable → warning only.
- **Cancel:** releases the plan (reserved drops), keeps any weighments in the log.

### 5.3 Order and sub-order lifecycle (derived)

Sub-order — first matching row wins:

| Condition | Status |
|---|---|
| `close_kind = cancel` (only allowed when dispatched = 0) | Cancelled |
| `close_kind = short_close` | Short closed |
| `close_kind = tolerance`, or pending = 0 and dispatched > 0 | Completed |
| dispatched > 0 | Partly dispatched |
| otherwise | Open |

Parent order: draft → **Draft**; all sub-orders cancelled → **Cancelled**; all terminal and ≥ 1 short closed → **Short closed**; all terminal → **Completed**; any dispatched > 0 → **Partly dispatched**; else **Open**.

Because status is derived, an owner weight correction that re-opens pending automatically moves Completed → Partly dispatched (tolerance close is undone in the same transaction if pending now exceeds tolerance).

**Transitions**
- **Short close** (owner, city staff; per sub-order): reason from list (Customer stopped lifting, Rate changed, Stock not available, Other) + optional note; sets `closed_kg = pending(l)` per line. If dispatched = 0 it is recorded as **Cancel**.
  - **Open trucks (client answer #25):** the app shows a confirmation listing every open truck with its state ("CG 04 MK 2291 — loading, tare 12.460 t"); trucks with a captured tare get an extra "may be loading now" warning. On confirm, one transaction cancels those trucks (releasing plans) and short-closes the sub-order. A later offline gross for a cancelled truck lands in Needs attention (§6.5).
- **Reopen** (owner only): clears `closed_*`, restores pending.
- **Drafts:** stored server-side, autosaved (debounced 3 s, versioned), no number, purged after 7 days.
- **Numbering:** parent `SO-YYMM-NNNN` — `NNNN` is one running series per tenant per financial year (continues across months, resets 1 April IST). Sub-orders append `-A`, `-B` in the order companies were added. Loading slip `LS-<CompanyCode>-YYMM-NNNN`, per company per FY, issued at dispatch by the server. All numbers come from `number_series` under row lock: never duplicated, gaps tolerated. Never issued on the phone.
- **Edits after dispatch starts** (non-owner): may add lines and change rate/qty of lines with no dispatches. `ordered` may never drop below `dispatched`; warn below `dispatched + reserved`. Lines with dispatches are rate-locked. Owner may edit anything.
- **Move quantity between companies** (default yes): one transaction editing both sub-orders, undispatched kg only, logged.
- **Company deactivation** blocked while it has non-terminal sub-orders.
- **Duplicate order** creates a new draft from an existing order.
- **Hard delete** (owner only; `allowHardDeleteAfterDispatch` flag, default true): typed order number confirmation; one transaction, order-level lock, fixed deletion order across sub-orders, lines, trucks, plans, weighments, allocations, rejections, ledger rows, activity, notifications. Removed from future backups only.

### 5.4 Pricing and money

- **Rate:** `direct` → typed rate; `basic_conversion` → `rate = basic + conversion_snapshot`. Any override sets `rate_edited` and is logged.
- **Billed rate** = `rate + overprice_per_mt` (customer is charged overprice).
- **Line value** = `round_half_up(ordered_kg × billed_rate / 1000)` whole ₹; order value = Σ lines (an estimate; actual value is on net). All rates are before GST.
- **Broker earning**, written in the dispatch transaction, one ledger row per truck:
  `round_half_up( Σ_lines net_kg × (commission_per_mt_snapshot + overprice_per_mt) / 1000 )`, rounded once per truck; per-line breakdown in `breakdown`. Check: 24.180 MT × (₹150 + ₹300) = ₹10,881.
- **No recalculation (client answer #24):** earnings are fixed at dispatch. Changing an order's commission or a line's rate/overprice affects only trucks dispatched afterwards — for every role, including owner. Only a weight correction rewrites a truck's earning (§5.2).
- **Payments:** amount, mode, UTR (required for NEFT and UPI), date, TDS (optional). **Sign convention:** `amount_rupees` is signed in the broker's favour — earning rows positive, payment rows negative (−(paid + tds)), and a reversal row is the exact negation of the row it reverses. So `due = Σ amount_rupees` over all of a broker's rows. Negative due → shown as "Advance ₹X" (overpayment allowed). Payments are never edited, only reversed.
- Short-closed orders: broker earns only on what was dispatched (automatic). Over-loaded trucks: broker earns on actual net.

### 5.5 Permissions (`packages/shared/policy.ts`)

Every route declares an action. Two checks on every request: (1) role allowed for the action; (2) **scope filter in SQL** — tenant always, plus `plant_id ∈ user_plants` for plant head and supervisor. Out-of-scope records return **404**, never 403. **Role serializers** omit money keys entirely (not null) for plant head and supervisor.

| Action | Owner | City staff / Accounts | Plant head | Supervisor |
|---|---|---|---|---|
| Create / edit / duplicate order | ✓ | ✓ (§5.3 limits) | — | — |
| Short close, cancel truck | ✓ | ✓ | — | — |
| Reopen, edit dispatched lines, correct weight after dispatch | ✓ | — | — | — |
| Hard delete | ✓ | — | — | — |
| Assign / edit vehicle | ✓ | ✓ | — | — |
| At gate, tare, gross + split | ✓ | — | — | ✓ own plant |
| View orders & dispatch | all | all | own plant, no money | own plant's trucks only |
| Parties, products, Excel import | ✓ | ✓ | — | — |
| Broker payments | ✓ | ✓ | — | — |
| Reports | ✓ | ✓ | — | Done today only |
| Users, companies, plants, settings | ✓ | — | — | — |

Users are deactivated, never deleted; deactivation revokes all refresh tokens.

### 5.6 Unit basis: MT/₹ or kg/₹ (per user)

Each user chooses a **unit basis** in Settings: **MT** (quantities in MT, rates in ₹/MT) or **kg** (quantities in kg, rates in ₹/kg). Default MT. It is stored on the user (`preferences.unitBasis`), so it follows them across devices, and applies to every screen they see, every value they type, and every report they export.

It is **display and input only** — storage is unchanged (integer kg, whole ₹ per MT), so switching is lossless in both directions:

| | MT basis | kg basis |
|---|---|---|
| Quantity shown / typed | 24.180 MT (3 decimals) | 24,180 kg (whole number) |
| Rate shown / typed | ₹46,300 / MT (whole ₹) | ₹46.300 / kg (up to 3 decimals) |
| Weighment keypad | decimal key, max 3 decimals | no decimal key, whole kg |
| Tolerance setting | ±1.000 MT | ±1,000 kg |

- ₹/kg input accepts up to 3 decimals because 1 ₹/MT = 0.001 ₹/kg; `rate_per_mt = ₹/kg × 1000` is then always a whole rupee, so no rounding is ever introduced by the conversion. More than 3 decimals → validation error.
- **Money totals are identical in both modes** (line value, order value, broker earning, ledger) because they are always computed from the stored kg and ₹/MT (§5.4).
- Conversion lives in one place: `packages/shared/units.ts` (`toDisplayQty`, `parseQtyInput`, `toDisplayRate`, `parseRateInput`) used by every input and formatter; the API always speaks kg and ₹/MT.
- Exports (Excel/PDF) use the exporting user's basis and label every column with its unit ("Net (kg)" / "Net (MT)").
- Messages to outside parties (WhatsApp to customer/broker, shared loading slips) use the tenant setting `externalUnitBasis` (default `mt`), not the sender's preference, so customers always see a consistent unit.

### 5.7 Concurrency and retries

- **Idempotency:** every mutating request from the app carries `Idempotency-Key`; the server stores key → response for 24 h. Retries cannot create a second order, truck or payment.
- **Optimistic locking:** edits send `version`; mismatch → `409 STALE`; app reloads and shows what changed.
- **Dispatch transaction:** `SELECT … FOR UPDATE` truck and its sub-order's lines → validate transition → insert weighment, allocations, ledger earning → tolerance auto-close check → issue loading-slip number → activity log → enqueue `notification_outbox` rows. Notifications are sent only after commit by the worker.

## 6. Offline weighment and sync

### 6.1 Scope
Supervisor only: My tasks, At gate, Tare, Gross + split, Done today. A truck must have been pulled to the phone before it can be weighed (unplanned-truck capture is a future upgrade, #26).

### 6.2 Device storage (SQLite)

| Table | Contents |
|---|---|
| `tasks` | Snapshot of open trucks at my plant: vehicle, driver, transporter, plan lines (product name, planned kg), tare if known, `server_version`, `local_state` |
| `done_today` | Today's dispatched trucks |
| `outbox` | `event_id` (UUIDv7), `truck_id`, `type` AT_GATE\|TARE\|GROSS, `payload` (kg, allocations), `captured_at_device`, `device_seq` (monotonic per device), `status` pending\|sending\|accepted\|rejected\|blocked, `attempts`, `error` |
| `sync_meta` | pull cursor, server clock offset, last successful sync |

Saving a weight is one SQLite transaction (insert outbox row + update task local state); the UI says "Saved on this phone" only after commit. No prices are ever stored on the device.

### 6.3 Pull
`GET /v1/supervisor/tasks?cursor=` returns changes since cursor `(updated_at, id)`, including tombstones for cancelled, reassigned or re-planted trucks. Triggered on foreground, every 60 s online, on reconnect, and on a silent "truck assigned" push. Server state is the base; pending local outbox events are re-applied on top for display.

### 6.4 Push
`POST /v1/weighments/sync {events[]}` ordered by `device_seq`. The server processes each event in its own transaction, in order, and returns per-event `accepted` (new server state, slip number for GROSS) / `duplicate` (already applied — treated as accepted) / `rejected` (code + server values). If an event is rejected, later events for the **same truck** are marked `blocked` and not sent. Retry with exponential backoff + jitter (2 s … max 5 min), triggered by reconnect, foreground and an Android periodic background task (~15 min).

### 6.5 Server validation and conflicts

| Case | Result |
|---|---|
| Truck not in tenant, or plant not in user's current plants | `rejected PLANT_SCOPE` |
| Tare already captured from another device | `rejected TARE_CONFLICT` + winning value, who, when (first synced wins) |
| Truck cancelled or reassigned meanwhile | `rejected TRUCK_CANCELLED` |
| gross ≤ tare, allocation sum ≠ net | `rejected INVALID_WEIGHT` / `ALLOC_MISMATCH` (also checked on device with shared rules) |
| Allocated line no longer on sub-order | `rejected LINE_REMOVED` |
| User deactivated | `401` on refresh; events stay on device; UI "Ask the owner" |

**No weight is ever lost:** every rejected event is copied to `weighment_rejections` and appears in the owner's notifications as **Needs attention**. The owner can **restore** (e.g. reinstate a mistakenly cancelled truck and apply the weights) or **dismiss with a reason**.

### 6.6 Time
Each sync estimates the device clock offset from the server `Date` header. Stored: `captured_at_device`, `captured_at` (offset-corrected), `received_at`. **Business time = `captured_at`** (a truck weighed 23:50 offline and synced 00:40 counts on the earlier day). Skew > 5 min is flagged in the activity log.

### 6.7 Auth while offline
Access token 15 min; refresh token 60 days, rolling, rotated on use, revoked on deactivation, stored in SecureStore. Capturing needs no token; sending does. Fingerprint after 15 min idle is a local lock that works offline. Sign-out is blocked while the outbox has unsynced rows; force sign-out requires typed confirmation and keeps the events.

### 6.8 After acceptance
Server issues the loading-slip number, writes the ledger earning, and enqueues WhatsApp (log-only) for customer and broker — the canvas's "Waiting for network" means not yet synced. Accepted outbox rows are purged after 7 days.

## 7. API surface

REST under `/v1`, JSON, bodies validated by shared zod schemas.

| Group | Endpoints (indicative) |
|---|---|
| auth | `POST /auth/request-code`, `POST /auth/verify`, `POST /auth/refresh`, `POST /auth/sign-out` |
| me / meta | `GET /me`, `GET /meta` (`minSupportedVersion`, server time) |
| org | `companies`, `plants`, `users` (invite, deactivate, plants) — owner |
| masters | `parties` (+ contacts, numbers, addresses, GSTIN format check), `products` |
| import | `POST /imports` (upload) → `PUT /imports/:id/mapping` → `POST /imports/:id/dry-run` → `POST /imports/:id/commit` |
| orders | list (filters: status, unit, search), detail, `POST /orders/drafts`, `PUT /orders/drafts/:id`, `POST /orders` (create), `PATCH /orders/:id`, `POST /orders/:id/duplicate`, `POST /sub-orders/:id/short-close` (with `cancelOpenTrucks: true`), `POST /sub-orders/:id/reopen`, `POST /orders/:id/move-quantity`, `DELETE /orders/:id` (hard delete, typed confirm) |
| trucks | `POST /sub-orders/:id/trucks` (assign), `PATCH /trucks/:id`, `POST /trucks/:id/cancel`, `POST /trucks/:id/correct-weight` (owner), dispatch board `GET /dispatch` |
| supervisor | `GET /supervisor/tasks`, `GET /supervisor/done-today`, `POST /weighments/sync` |
| rejections | `GET /weighment-rejections`, `POST /weighment-rejections/:id/restore`, `POST /weighment-rejections/:id/dismiss` |
| money | `GET /brokers/:id/ledger`, `POST /brokers/:id/payments`, `POST /ledger/:id/reverse` |
| reports | `GET /reports/:kind` (JSON), `POST /reports/:kind/export` (xlsx\|pdf) |
| notifications | list, mark read, register push token |
| settings | tenant settings — owner |

### Error contract

| HTTP | When | App behaviour |
|---|---|---|
| 422 `VALIDATION` | zod failure; field paths in `details` | inline field errors |
| 409 domain code (`STALE`, `ORDER_LOCKED`, `OPEN_TRUCKS`, `ALLOC_MISMATCH`, `TARE_CONFLICT`, `CUSTOMER_REQUIRED`, `LINE_NOT_ON_ORDER`, `COMPANY_INACTIVE`, …) | business rule refused | copy per code; Reload for `STALE` |
| 401 / 403 | token / role | refresh or sign out / "You don't have access" |
| 404 | not found **or out of scope** | not found |
| 5xx / network | — | auto-retry only for idempotent requests or ones with an idempotency key |

Body shape: `{ code, message, details? }`.

## 8. Mobile app

### 8.1 Navigation
`(auth)/sign-in` (number → code → optional fingerprint). `(app)/_layout` loads `/me` and selects a tab set by role:
- Owner, city staff: Home · Orders · **New** · Dispatch · More
- Plant head: Home · Orders · Dispatch (read-only, no money)
- Supervisor: My tasks · Done · Profile

Every route declares its allowed roles; forbidden routes (including deep links) redirect.

### 8.2 State
TanStack Query for server data; query keys include the unit filter (`companyId | 'all'`) held in Zustand, so the unit switcher refetches every screen. Mutations invalidate affected keys; **no optimistic updates for money, quantities or status**. Forms use react-hook-form with the shared zod schemas. Device settings (theme Light/Dark/Auto, text size, fingerprint) in SecureStore/MMKV; the unit basis (MT/₹ or kg/₹) is a user preference on the server, cached locally so it also applies offline; tenant settings on the server. Changing unit basis re-renders every screen immediately — no refetch needed, since API values are always kg and ₹/MT.

### 8.3 Flows
1. **Book order:** Parties (type, customer/broker, commission from profile editable per order, bill-to, ship-to) → Items (pricing method; per company: lines with product filtered by `product_companies`, length from standard lengths or any 1–100 in m/ft/mm, MT, rate, overprice) → Review (sub-orders, estimated value, estimated broker earning, WhatsApp toggles) → Create (idempotency key). Server recomputes totals; if they differ from the preview the server wins and the screen shows the difference.
2. **Assign vehicle:** sub-order → plant (only if > 1) → vehicle (recents), transporter or Self, driver, LR (optional) → load plan per line (warning if over assignable) → push + silent sync to that plant's supervisors.
3. **Weigh:** task → At gate (optional) → Tare (keypad) → Gross (keypad; live net and plan difference) → split if > 1 line → Save & dispatch → Dispatched screen. Keypad: max 3 decimals, 7 chars. 50–150 % plausibility confirmation.
4. **Short close:** per sub-order; pending per line; reason + note; open-truck confirmation (§5.3).
5. **Record payment:** amount (Full / Half shortcuts), mode, UTR, date, TDS → preview of new due → Record.
6. **Hard delete:** sheet listing what will be erased with counts → type order number.
7. **Invite user:** name, mobile, role, plants (supervisor exactly one); "can / cannot" list generated from `policy.ts`.
8. **Excel import:** upload → column mapping (auto-guessed from headers) → dry run (Ready / Duplicates / Errors with row numbers: invalid GSTIN, existing GSTIN, same name + city, same phone) → commit Ready rows in one transaction → skipped-rows report.
9. **First run:** empty state with setup checklist (companies → products → parties → staff).
10. **Needs attention** (owner): list of rejected weighments with restore / dismiss.

### 8.4 UI system
- Tokens copied from the canvas: light and Graphite dark palettes (`bg, card, ctl, act, bd, bd2, tx, tx2, tx3, inv, br/brt/brs, vi/vis, ok/okt/oks, wnt/wns, dgt/dgs`), unit tag colours (AIP/VSL/KRM/NAP → per-company colour slot). Inter 400/500/600, tabular numerals; Large text ×1.15.
- Components: `Screen`, `Header`, `TabBar`, `Group`/`Row`, `Badge(kind)`, `UnitTag`, `Chip`, `ProgressBar`, `Button(primary|secondary|danger)`, `Sheet`, `Keypad`, `SegmentedControl`, `OtpInput`, `MoneyText`, `QtyText`, `EmptyState`.
- Formatters (shared): quantity and rate follow the user's unit basis (§5.6) — MT always 3 decimals, kg whole numbers with Indian grouping; ₹ Indian grouping (₹1,46,000) and short (₹38.64 L, ₹1.46 Cr); IST relative dates.
- Tablet (≥ 768 dp): Orders and Dispatch use the split view; other screens responsive single column.
- Accessibility: touch targets ≥ 44, labels on icon-only buttons, canvas contrast-checked colours, live region on the weight readout.

### 8.5 Reports
Server-side SQL, IST date range, unit filter. Kinds: dispatch register, pending orders (ageing buckets), company-wise sales, broker-wise, customer-wise, product-wise, over/under loading (columns per decisions register §11). Export xlsx (exceljs) and PDF (pdfmake), shared via expo-sharing. The per-company dispatch register (one row per truck line) is the Tally hand-off.

### 8.6 Notifications
Push (Expo) for: new order for my plant, truck assigned, dispatched, aged orders (> `agedOrderDays`), over-tolerance loading, needs attention. WhatsApp events (log-only until #11): order created, truck dispatched, order completed/short closed, broker payment — to numbers flagged WhatsApp.

## 9. Security and operations

- Rate limits on auth endpoints; 5 wrong codes → per-number lockout.
- Secrets only in env vars; dev OTP provider blocked in production.
- Structured logs (pino) with request id, tenant, user, route; Sentry for app and API.
- Migrations: drizzle-kit generated, reviewed, forward-only; destructive changes via expand → contract.
- Backups: provider history + nightly `pg_dump` via GitHub Actions cron to private storage, 30-day retention. Data region decision required before go-live.
- App updates: EAS Update for JS; `/meta.minSupportedVersion` forces store update for breaking changes. Minimum Android 9.
- Seed script with the canvas sample world (Aarav AIP, Vrinda VSL, Kalinga KRM, Nandan NAP; Shubham Traders; R.K. Agarwal; Shree Ganesh Roadlines) for demos and E2E.

## 10. Testing

### 10.1 Layers
1. **`shared/rules` and `shared/units`** — unit + property-based (fast-check): kg↔MT and ₹/kg↔₹/MT round-trip losslessly and money totals are identical in both bases; pending never negative; allocations sum to net; half-up rounding stable; tolerance close; exhaustive status-derivation tables.
2. **API integration against real Postgres** (Docker locally, service container in CI; no DB mocks):
   - permission matrix generated from `policy.ts` (every role × action), plus cross-tenant and cross-plant reads/writes → 404;
   - serializer leak test: walk every plant-head and supervisor response, fail on any money key;
   - concurrency: two simultaneous dispatches of one truck (exactly one wins); 50 parallel number issues (no duplicates); short close racing assignment;
   - sync: replay, duplicate, out-of-order, tare conflict, cancelled truck, deactivated user, clock skew;
   - hard delete leaves zero rows in every table.
3. **Mobile:** Jest + React Native Testing Library (keypad, split form, formatters, outbox state machine on in-memory SQLite); Maestro E2E for sign-in → book order and offline weighing (airplane mode on → weigh → off → synced).

### 10.2 CI
GitHub Actions: lint, typecheck, unit, integration, migration check on every push.

### 10.3 End-to-end scenarios (from the decisions register)
1. Owner books a 2-company order with a broker and overprice, two lengths of one product.
2. City staff assigns three trucks; one over-loads, one under-loads, one is cancelled after tare.
3. Supervisor weighs two trucks offline; the phone syncs an hour later.
4. Owner short-closes the remainder of one sub-order; broker share reflects only dispatched weight.
5. Accounts records a part payment to the broker; ledger shows the new due.
6. Owner hard-deletes a test order with dispatched trucks; nothing remains anywhere.

## 11. Canvas changes required

1. Remove the separate "Gross weighed" status (Home, Dispatch board, Dispatch detail progress) — gross and dispatch are one action.
2. Roles: merge Sales and Accounts into **City staff / Accounts**; add **Plant head** (Users & roles, Invite user, More).
3. Add the **net split across lines** step to the gross weight flow.
4. Add **Needs attention** (rejected weighments) list and detail.
5. Add the **short close with open trucks** confirmation listing the trucks.
6. Settings: "Allow over / under loading" → "Completion tolerance ±1.000 MT".
7. Settings → Appearance: add **Units: MT / ₹ per MT · kg / ₹ per kg** segmented control; supervisor Profile gets the same control.

## 12. Delivery milestones

Each milestone gets its own implementation plan.

| # | Milestone | Contents |
|---|---|---|
| M1 | Foundation | monorepo, CI, DB schema + RLS + migrations, auth (dev OTP, tokens, fingerprint), `policy.ts` + guards + serializers, users, companies, plants, theme + components, app shell with role tabs |
| M2 | Masters & orders | parties, products, order wizard, drafts, numbering, order list/detail, edits, move quantity, short close (incl. open-truck cancel), reopen, cancel, hard delete |
| M3 | Dispatch & offline weighing | assign/edit/cancel truck, dispatch board/detail, supervisor app, outbox + sync, tolerance close, loading slip numbers, weight correction, Needs attention |
| M4 | Money & reports | broker ledger, payments, reversals, all reports, Excel/PDF export |
| M5 | Remaining canvas | Excel import, notifications + push + outbox worker, settings, tablet split view, empty state, unit switcher polish |

## 13. Open client questions

Built on the decisions register's default until answered; each is isolated in config, `policy.ts`, or a single module.

| # | Question | Built default | Where it lives |
|---|---|---|---|
| 2 | More than one plant per company? | Yes (plant is a child of company) | schema |
| 4 | Hard delete after dispatch / Tally billing? | Allowed with typed confirm | `allowHardDeleteAfterDispatch` |
| 5 | Activity log vs no history | Basic event log, removed by hard delete | `activity_log` |
| 6 | When must a broker-only order get a customer? | Before the first truck is assigned | assignment guard |
| 7 | Truck carrying several lines — net split | Supervisor enters kg per line, must equal net | split step |
| 8 | Rates below floor; who short-closes; plant head sees money? | Allowed + flagged; owner + city staff; no | `policy.ts` |
| 9 | Broker payments here? TDS? | Yes; optional TDS field | ledger |
| 10 | Overprice part of billed rate? | Yes | `rules/pricing` |
| 11 | WhatsApp recipients, number, provider, cost | Log-only notifier | `Notifier` |
| 12 | Conversion differs by company/length? | No | product |
| 13 | HR needs? | Out of scope | — |
| 14 | Volumes (orders/day, trucks/day, users) | Free-tier sizing | infra |
| 15 | Current Excel sheet | Generic import mapping | import |
| 16–22 | Billing basis, pieces/bundles, heat no./MTC, freight terms, gate pass format, e-way bill no., payment terms | Weighbridge net; no pieces/heat/MTC/e-way fields in v1; ex-works; auto-numbered loading slip; payment terms as text | schema extensions later |

**Answered in this design:** #1 multi-tenant-ready, one tenant at launch · #3 offline weighment yes · #23 ±1 MT completion tolerance · #24 no recalculation of past broker earnings · #25 confirm and cancel open trucks on short close · #26 unplanned-truck offline capture deferred.
