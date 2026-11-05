import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { NetworkError, type TokenPair, tokenPairSchema } from '@tonnage/shared';
import { create } from 'zustand';
import { timed } from '../api/netStatus';
import { getTransport } from '../api/transport';
import { getDevicePrefs } from '../prefs/device';

export const REFRESH_KEY = 'tonnage.refresh';
export const DEVICE_KEY = 'tonnage.device';

/** A cold start never waits longer than this for the server before opening the app. */
export const STARTUP_REFRESH_WAIT_MS = 8_000;

export type SessionStatus = 'loading' | 'signedOut' | 'signedIn' | 'locked';

interface SessionState {
  status: SessionStatus;
  /** Short-lived (15 min); memory only. */
  accessToken?: string;
  /** 60-day rotating token; also in SecureStore so a cold start can resume. */
  refreshToken?: string;
  /** Stable per install; refresh tokens are bound to it. */
  deviceId: string;

  /**
   * Cold start: read the device id and any stored refresh token, then try to resume. With
   * fingerprint unlock on, a resumed session starts locked — reopening the app is not a way past
   * the lock.
   */
  init(): Promise<void>;
  ensureDeviceId(): Promise<string>;
  signIn(pair: TokenPair): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Rotates the token pair. Concurrent callers share one request. Resolves `true` on success and
   * `false` when the server refuses (the user is then signed out) or the session changed meanwhile;
   * rejects with `NetworkError` when offline or on a server error, leaving the session as it is.
   */
  refresh(): Promise<boolean>;
  lock(): void;
  unlock(): void;
}

let inflight: Promise<boolean> | null = null;
/**
 * Bumped by signIn and signOut. A refresh that started in an older epoch must not write its
 * result back — otherwise a sign-out racing a refresh could revive the session.
 */
let epoch = 0;
/** A refresh token the server issued after the session it belonged to was signed out. */
let orphan: string | undefined;

const initial = {
  status: 'loading' as SessionStatus,
  accessToken: undefined,
  refreshToken: undefined,
  deviceId: '',
};

async function revoke(refreshToken: string): Promise<void> {
  try {
    const t = await getTransport();
    await timed(
      t.request({ method: 'POST', path: '/v1/auth/sign-out', headers: {}, body: { refreshToken } }),
    );
  } catch {
    // Offline or server error: the token still expires on its own; sign-out on this phone goes on.
  }
}

export const useSession = create<SessionState>((set, get) => ({
  ...initial,

  async ensureDeviceId() {
    if (get().deviceId) return get().deviceId;
    let id = await SecureStore.getItemAsync(DEVICE_KEY);
    if (!id) {
      id = Crypto.randomUUID();
      await SecureStore.setItemAsync(DEVICE_KEY, id);
    }
    set({ deviceId: id });
    return id;
  },

  async init() {
    await get().ensureDeviceId();
    const refreshToken = (await SecureStore.getItemAsync(REFRESH_KEY)) ?? undefined;
    if (!refreshToken) {
      set({ status: 'signedOut' });
      return;
    }
    set({ refreshToken });
    const resumed: SessionStatus = (await getDevicePrefs()).fingerprint ? 'locked' : 'signedIn';

    const attempt = get()
      .refresh()
      .then((ok) => (ok ? 'ok' : 'refused'))
      .catch((e: unknown) => {
        if (e instanceof NetworkError) return 'offline' as const;
        throw e;
      });
    let cap: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      cap = setTimeout(() => resolve('slow'), STARTUP_REFRESH_WAIT_MS);
    });
    const outcome = await Promise.race([attempt, slow]);
    clearTimeout(cap);
    // Refused → refresh() already signed out. Offline or slow → open with the stored session; the
    // next request refreshes once the network is back (a slow refresh keeps going meanwhile).
    if (outcome !== 'refused') set({ status: resumed });
  },

  async signIn(pair) {
    epoch += 1;
    await SecureStore.setItemAsync(REFRESH_KEY, pair.refreshToken);
    set({ status: 'signedIn', accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  },

  async signOut() {
    epoch += 1;
    const { refreshToken } = get();
    const pending = inflight;
    // Signed out on this phone at once, whatever the network does next.
    set({ status: 'signedOut', accessToken: undefined, refreshToken: undefined });
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    if (refreshToken) await revoke(refreshToken);
    // A refresh that was in flight may have been rotated by the server: revoke its successor too.
    if (pending) await pending.catch(() => false);
    if (orphan) {
      const o = orphan;
      orphan = undefined;
      await revoke(o);
    }
  },

  refresh() {
    inflight ??= (async () => {
      const started = epoch;
      const { refreshToken, deviceId } = get();
      if (!refreshToken) return false;
      const t = await getTransport();
      const res = await timed(
        t.request({
          method: 'POST',
          path: '/v1/auth/refresh',
          headers: {},
          body: { refreshToken, deviceId },
        }),
      );
      if (started !== epoch) {
        // Signed out (or in as someone else) meanwhile: never write this result back.
        if (res.status === 200) orphan = tokenPairSchema.parse(res.body).refreshToken;
        return false;
      }
      if (res.status === 200) {
        const pair = tokenPairSchema.parse(res.body);
        // Persist before use: if the app dies now, the next launch has the live token.
        await SecureStore.setItemAsync(REFRESH_KEY, pair.refreshToken);
        if (started !== epoch) {
          orphan = pair.refreshToken;
          await SecureStore.deleteItemAsync(REFRESH_KEY);
          return false;
        }
        set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
        return true;
      }
      if (res.status === 401) {
        // The server refused the token (expired, revoked, reused): sign out on this phone. Not via
        // signOut(), which waits for the in-flight refresh — this one.
        epoch += 1;
        set({ status: 'signedOut', accessToken: undefined, refreshToken: undefined });
        await SecureStore.deleteItemAsync(REFRESH_KEY);
        return false;
      }
      // 5xx and the like: a server hiccup must not sign everyone out.
      throw new NetworkError(`Refresh failed (${res.status})`);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  lock() {
    if (get().status === 'signedIn') set({ status: 'locked' });
  },

  unlock() {
    if (get().status === 'locked') set({ status: 'signedIn' });
  },
}));

/** Tests and "app killed" simulations: forget everything held in memory. */
export function resetSessionForTests(): void {
  inflight = null;
  orphan = undefined;
  epoch += 1;
  useSession.setState(initial);
}
