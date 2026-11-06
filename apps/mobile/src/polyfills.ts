import * as Crypto from 'expo-crypto';

// The in-app mock API generates UUIDv7 ids with the `uuid` package, which needs
// `crypto.getRandomValues`. Hermes may not provide it; expo-crypto does (works in Expo Go).
// Imported first by the root layout.
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: Crypto.getRandomValues };
}
