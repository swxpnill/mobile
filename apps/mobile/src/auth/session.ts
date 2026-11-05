import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { NetworkError, type TokenPair, tokenPairSchema } from '@tonnage/shared';
import { create } from 'zustand';
import { getTransport } from '../api/transport';

export const REFRESH_KEY = 'tonnage.refresh';
export const DEVICE_KEY = 'tonnage.device';

export type SessionStatus = 'loading' | 'signedOut' | 'signedIn' | 'locked';

interface SessionState {
  status: SessionStatus;
  /** Short-lived (15 min); memory only. */
  accessToken?: string;
  /** 60-day rotating token; also in SecureStore so a cold start can resume. */
  refreshToken?: string;
  /** Stable per install; refresh tokens are bound to it. */
  deviceId: string;

  /** Cold start: read the device id and any stored refresh token, then try to resume. */
  init(): Promise<void>;
  ensureDeviceId(): Promise<string>;
  signIn(pair: TokenPair): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Rotates the token pair. Concurrent callers share one request. Resolves `true` on success and
   * `false` when the server refuses (the user is then signed out); rejects with `NetworkError`
   * when offline, leaving the session as it is.
   */
  refresh(): Promise<boolean>;
  lock(): void;
  unlock(): void;
}

let inflight: Promise<boolean> | null = null;

const initial = {
  status: 'loading' as SessionStatus,
  accessToken: undefined,
  refreshToken: undefined,
  deviceId: '',
};

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
    try {
      const ok = await get().refresh();
      if (ok) set({ status: 'signedIn' });
    } catch (e) {
      // Offline at launch: stay signed in; the next request refreshes once the network is back.
      if (e instanceof NetworkError) set({ status: 'signedIn' });
      else throw e;
    }
  },

  async signIn(pair) {
    await SecureStore.setItemAsync(REFRESH_KEY, pair.refreshToken);
    set({ status: 'signedIn', accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  },

  async signOut() {
    const { refreshToken } = get();
    if (refreshToken) {
      try {
        const t = await getTransport();
        await t.request({
          method: 'POST',
          path: '/v1/auth/sign-out',
          headers: {},
          body: { refreshToken },
        });
      } catch {
        // Offline or server error: still sign out on this phone.
      }
    }
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    set({ status: 'signedOut', accessToken: undefined, refreshToken: undefined });
  },

  refresh() {
    inflight ??= (async () => {
      const { refreshToken, deviceId } = get();
      if (!refreshToken) return false;
      const t = await getTransport();
      const res = await t.request({
        method: 'POST',
        path: '/v1/auth/refresh',
        headers: {},
        body: { refreshToken, deviceId },
      });
      if (res.status === 200) {
        const pair = tokenPairSchema.parse(res.body);
        await SecureStore.setItemAsync(REFRESH_KEY, pair.refreshToken);
        set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
        return true;
      }
      if (res.status === 401) {
        await get().signOut();
        return false;
      }
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
  useSession.setState(initial);
}
