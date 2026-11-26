# Changelog

All notable changes to Tonnage are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each milestone is tagged on its merge commit.

## [Unreleased]

### Added

- B2 (orders on Postgres): the M2 routes (parties, products, orders, drafts, Home and the order lifecycle) run on Postgres with RLS; the M1 and M2 contract suites are green against the API; a generated permission matrix and a money-leak check over every GET; the masters seed with the mock's ids; `apiVersion` in `GET /v1/meta`.
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
