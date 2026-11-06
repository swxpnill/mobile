# Tonnage

Order and dispatch for steel units: orders, sub-orders per company, truck dispatch with plant weighment, and broker commissions. Android first (Expo / React Native), with a TypeScript monorepo shared with the future API.

Right now the app runs entirely on an **in-app mock API**: no server, database or Docker needed. The real backend arrives in the B milestones behind the same contract.

## Repository

| Path | What it is |
|---|---|
| `apps/mobile` | The Expo app (Expo Router, TanStack Query, Zustand) |
| `packages/shared` | Schemas, permissions, redaction, units and formatters, used by app, mock and API |
| `packages/mock-api` | The in-app API: same routes, rules and errors as the real one |
| `packages/contract-tests` | One API test suite that every backend must pass |
| `docs/superpowers` | Design spec and implementation plans |

## Setup on Windows

You need **Node 22** and **Git**. That is all; there is no Docker in the F milestones.

```powershell
corepack enable      # gives you the pnpm version pinned in package.json
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

All commands work in PowerShell and in Git Bash. If `corepack enable` fails with a permissions error, run the terminal once as Administrator.

## Running the app on your phone (Expo Go)

1. Install **Expo Go** from the Play Store.
2. Put the phone and the computer on the **same Wi-Fi**.
3. Start the dev server:

   ```powershell
   cd apps/mobile
   npx expo start
   ```

4. In Expo Go, scan the QR code shown in the terminal.

If the phone can't connect:
- Allow Node.js through Windows Firewall on **private** networks (Windows asks the first time Metro starts).
- Make sure the Wi-Fi is set to a *Private* network in Windows, not *Public*.
- Some routers isolate devices (guest or office Wi-Fi). Use `npx expo start --tunnel` instead, which is slower but works across networks.

### Android emulator

With Android Studio installed and an emulator running (`emulator -list-avds`, then `emulator -avd <name>`), run `npx expo start --android`. The app opens in Expo Go on the emulator.

If the computer's Wi-Fi address changes (the app then fails with "Failed to download remote update"), connect the emulator through adb port forwarding instead, which doesn't depend on the network:

```powershell
npx expo start --localhost
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8081"
```

## Signing in

The OTP code is always **123456**. Try:

- **Rajesh Agrawal**, Owner: `98261 00012`
- **Ravi Verma**, Supervisor at Siltara: `98261 00014`

Or tap **Sign in as a sample person** to choose anyone without a code. The full list is in `CLAUDE.md`.

Demo data is saved on the phone. **More → Demo tools** can reset it, switch person, simulate being offline or a slow server, and make the next request fail, so error and retry screens can be tried.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_MODE` | `mock` | `mock` = in-app API; `http` = real API (B milestones) |
| `EXPO_PUBLIC_API_URL` | (none) | Real API base URL when the mode is `http` |
| `EXPO_PUBLIC_DEMO_TOOLS` | (off) | `1` keeps Demo tools in a release build for client demos (mock mode only) |

Put local values in `apps/mobile/.env` (git-ignored).
