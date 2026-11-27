# Changelog

All notable changes to Tonnage are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each milestone is tagged on its merge commit.

## [Unreleased]

### Fixed

- Move quantity gives the source and target sub-orders a new version, so a short close from an older screen is 409 `STALE`.
- A repeated order number (a format without `YYMM` after the financial year resets) is 409 `ORDER_NUMBER_TAKEN`, not 500.
- An order edit that repeats a line id is 422 `VALIDATION`.

### Added

- Welcome, role tours and first-visit tips (canvas 41–46): Welcome back when the app is reopened or unlocked, a first sign-in intro, spotlight tours over the real screens for owner, city staff, plant head and supervisor, one-time tips on nine screens, and More / Profile → Help & tour (replay, the team's tours, How do I…, tips on or off). Progress is per person on the phone; Demo tools → Replay first sign-in shows it again.
- B2 (orders on Postgres): the M2 routes (parties, products, orders, drafts, Home and the order lifecycle) run on Postgres with RLS; the M1 and M2 contract suites are green against the API; a generated permission matrix and a money-leak check over every GET; the masters seed with the mock's ids; `apiVersion` in `GET /v1/meta`.
- API database timeouts: every request transaction sets `lock_timeout` and `statement_timeout` (`DB_LOCK_TIMEOUT_MS`, default 5 s; `DB_STATEMENT_TIMEOUT_MS`, default 15 s); a deadlock, serialization failure or lock timeout answers 503 `BUSY` with `Retry-After`.
- Delivery lifecycle: this changelog, a pull request template, Dependabot, and CI that cancels superseded runs and caches the pnpm store.

## 2026-11-25

- Request vehicle: call or WhatsApp the broker or customer for an order's pending material, with an offline queue.

## 2026-11-23

- B1 (API foundation): Fastify and Drizzle on Postgres with RLS, auth, the request pipeline and the M1 routes (auth, me, companies, plants, users, settings).

## 2026-11-21

- F5 (notifications and polish): notifications list and simulated push, background sync for supervisors, Graphite dark theme, accessibility pass, the Create sheet, and TON-57 (Vehicle arrived, per-line weights, approval, supervisor contact).

## 2026-11-18

- F4 (money and reports): broker dues, ledger, record and reverse payment, and the seven reports.
- F3 (dispatch and offline weighment): assign vehicle, Dispatch board, supervisor capture with outbox and sync, Needs attention.

## 2026-11-13

- F2 (masters and orders): customers, brokers, transporters, products, Home, Orders, order detail, the new-order wizard and the order lifecycle.

## 2026-11-06

- F1 (app foundation): sign-in, app shell, admin screens and demo tools.
