# CLAUDE.md
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Tonnage**: an Android-first order and dispatch app for a group of steel companies (one owner, several companies each with its own GSTIN, plants under each company). Flow: order → sub-order per company → truck assignment → plant weighment (tare/gross, net = dispatched) → broker commission ledger.

Delivery is **frontend first**: the whole app (milestones F1–F5) runs on an in-app mock API, then the real backend (B1–B5) is built to the same contract. F1 (app foundation: sign-in, app shell, admin screens, demo tools) is done.

## Commands

Run from the repo root (pnpm workspaces; Node 22; Windows, Git Bash or PowerShell).

```sh
corepack enable          # once; provides the pinned pnpm
pnpm install
pnpm lint                # eslint, every package
pnpm typecheck           # tsc --noEmit, every package
pnpm test                # vitest (packages) + jest (apps/mobile)
```

Single tests:

```sh
pnpm --filter @tonnage/shared exec vitest run src/units.test.ts
pnpm --filter @tonnage/contract-tests exec vitest run -t "LAST_OWNER"
pnpm --filter mobile exec jest test/shell.test.tsx
pnpm --filter mobile exec jest -t "switching person"
```

Run the app (Expo Go, no native build):

```sh
cd apps/mobile
npx expo start             # scan the QR code with Expo Go on a phone on the same Wi-Fi
npx expo start --android   # or open it in a running Android emulator
```

Do not set `CI=1` while developing: Metro then disables reloads. For the emulator, `npx expo start --localhost` plus `adb reverse tcp:8081 tcp:8081` and opening `exp://127.0.0.1:8081` survives Wi-Fi address changes. When driving the emulator with `adb shell input text`, focus a real `EditText` first: keys typed with nothing focused reach Expo's dev shortcuts (`r r` reloads, `i` opens the inspector).

## Architecture

```
apps/mobile (Expo Router)
  screens/hooks ─▶ src/api/client.ts ─▶ Transport ─┬─▶ packages/mock-api   (EXPO_PUBLIC_API_MODE=mock, default)
                                                   └─▶ HTTP to apps/api    (EXPO_PUBLIC_API_MODE=http, B milestones)
packages/shared ── zod schemas · policy · redaction · units/formatters · error codes   (used by mobile, mock and future API)
packages/contract-tests ── one HTTP-level suite run against any Transport
```

- **One seam.** The app talks to a backend only through `Transport` (`packages/shared/src/transport.ts`). Screens and hooks never know whether the mock or the real API is behind it. Switching to the real API must be a config change, not a screen change.
- **The mock behaves like the real API.** `packages/mock-api` validates with the shared zod schemas, authorises with `policy.ts` + plant scope, redacts with `redactForRole`, returns the spec's error bodies `{ code, message, details? }`, honours `Idempotency-Key` and optimistic `version`, and simulates token expiry so refresh runs. Out-of-scope records are 404, never 403. Every route declares an `action` or `public: true`, or the router throws when it is built. The store persists to AsyncStorage.
- **The contract suite is the definition of done** for both backends (`packages/contract-tests`). It runs against the mock now and must run green against the Fastify app in the B milestones. A change to behaviour starts with a contract test.
- `packages/shared` and `packages/mock-api` import nothing from React Native or Expo.
- **Numbers.** Quantities are integer kg; money is integer rupees; rates are whole ₹ per MT. No floats in stored values or in arithmetic on them. Unit basis (`mt` | `kg`, per user, `preferences.unitBasis`) only changes display and input: MT shows 3 decimals, kg whole numbers. Use the formatters in `packages/shared/src/units.ts` / `format.ts`; never format quantities by hand. Business time zone is `Asia/Kolkata`.
- **Roles:** `owner | city_staff | plant_head | supervisor`. A supervisor has exactly one plant, a plant head one or more, owner and city staff none (they see all). Money fields are omitted (not null) for plant head and supervisor. Tabs per role live in `apps/mobile/src/nav/tabs.ts`.
- **Expo Go only.** No custom native modules; anything that needs a dev client is out until the plan says otherwise.

### Mobile layout (`apps/mobile`)

- `app/`: Expo Router routes. `(auth)` = sign-in, verify, demo sign-in; `(app)` = signed-in area with `(tabs)` plus companies, users, settings, demo-tools.
- `src/api/`: `client.ts` (auth headers, refresh, idempotency, retry), `transport.ts` (mock vs http), `hooks/` (TanStack Query hooks), `demo.ts` (demo-tools gating).
- `src/auth/`: session (SecureStore tokens) and fingerprint lock (after 15 min idle).
- `src/ui/`: primitives built on `src/theme/tokens.ts`. Colours, copy and spacing come from the design canvas; use tokens, never raw hex.
- `src/screens/`: screen components; route files in `app/` stay thin.
- `src/nav/`: role tabs (`tabs.ts`), route guards, and `freshStart.ts` (a person switch resets the signed-in stack so no tabs or history carry over; this expo-router only accepts a complete state on RESET).
- `test/`: jest + React Native Testing Library; `test/router.test.tsx` runs the real tabs layout under `expo-router/testing-library`. In RNTL 14 `unmount()` is async: always `await` it, and use `advanceTimersByTimeAsync` with fake timers.

## Signing in (mock mode)

- OTP code is always **`123456`** (OTP SMS is paused; the real API refuses the dev provider in production).
- Seeded people (`packages/shared/src/fixtures/sample-world.ts`, tenant "Agrawal Group"):

| Person | Role | Mobile | Plant |
|---|---|---|---|
| Rajesh Agrawal | Owner | 98261 00012 | all |
| Priya Sharma | City staff | 98261 00013 | all |
| Amit Verma | City staff | 94250 67890 | all |
| Kiran Rao | Plant head | 98261 00018 | Siltara |
| Ravi Verma | Supervisor | 98261 00014 | Siltara |
| Sanjay Patel | Supervisor | 98261 00015 | Borai |
| Mohan Kurre | Supervisor | 98261 00016 | Urla |
| Deepak Sahu | Supervisor (invited) | 98261 00017 | Tilda |

- "Sign in as a sample person" on the Sign in screen skips the code.

## Demo tools

More → Demo tools. Shown only in mock mode in dev builds, or when a client demo build sets `EXPO_PUBLIC_DEMO_TOOLS=1`; never against the real API. They let you reset demo data, switch person, simulate Offline, set server latency (0 / 800 ms / 6 s "waking server"), and arm a failure for the next request (network error or an error code such as `STALE`, which only fires on writes). Switching person always turns simulated Offline off.

## Where decisions live

- Spec (binding): `docs/superpowers/specs/2026-11-04-tonnage-design.md`
- Plans: `docs/superpowers/plans/` (`2026-11-04-f1-app-foundation.md`, `2026-11-04-b1-api-foundation.md`; F2+ to be written)
- Business rules, "Decisions Needed to Build" doc (source of truth for rules; open client questions use the doc's Default): https://claude.ai/artifact/7f2fd784-5809-4ac7-ba0f-42a25abdba23
- Design canvas (source of truth for UI and copy): https://claude.ai/artifact/1cf17fda-d3a4-498b-b46d-c67fdc49f795. Its older role names lose to the decisions doc: Owner, City staff, Plant head, Supervisor.
- Task tracker (Notion "Tonnage Tasks"): https://app.notion.com/p/40e2c11ff0af81b391b2d7b4ac03b04f

## Conventions

- Commits: Conventional Commits with scope, e.g. `feat(mobile): …`, `fix(mock-api): …`.
- Tests first: a failing test before the fix or feature. CI (`.github/workflows`) runs lint, typecheck and test.
- Scripts must work in both Git Bash and PowerShell: no `rm -rf`, no `export X=`.
- When a business rule is unclear, check the decisions doc's Decided / Default / Open status before asking; build the Default and keep likely-to-change rules isolated and configurable.
