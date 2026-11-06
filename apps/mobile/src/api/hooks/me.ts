import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Me, type UnitBasis, meSchema } from '@tonnage/shared';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useContext, useEffect } from 'react';
import { useSession } from '../../auth/session';
import { api } from '../client';
import { hideToast } from '../../ui/Toast';

/** Last known profile, so the app can open on the right tabs without the network. */
export const ME_CACHE_KEY = 'tonnage.me';
export const ME_KEY = ['me'] as const;

function cacheMe(me: Me): void {
  void AsyncStorage.setItem(ME_CACHE_KEY, JSON.stringify(me)).catch(() => undefined);
}

/** The identity a request started under is still the one signed in. */
const stillCurrent = (identity: number) => useSession.getState().identity === identity;

/** The signed-in user (`/v1/me`), refetched on focus, seeded from the offline cache. */
export function useMe() {
  const qc = useQueryClient();
  const status = useSession((s) => s.status);
  const resumed = useSession((s) => s.resumed);
  const enabled = status === 'signedIn' || status === 'locked';

  useEffect(() => {
    // The offline copy only stands in for a session resumed at launch. After a sign-in on this
    // run it could belong to someone else, so the network answer is awaited instead.
    if (!enabled || !resumed || qc.getQueryData(ME_KEY)) return;
    const identity = useSession.getState().identity;
    void AsyncStorage.getItem(ME_CACHE_KEY)
      .then((raw) => {
        const parsed = raw ? meSchema.safeParse(JSON.parse(raw)) : null;
        // updatedAt 0: shown at once, but always refetched.
        if (parsed?.success && stillCurrent(identity) && !qc.getQueryData(ME_KEY)) {
          qc.setQueryData(ME_KEY, parsed.data, { updatedAt: 0 });
        }
      })
      .catch(() => undefined);
  }, [enabled, resumed, qc]);

  return useQuery({
    queryKey: ME_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const identity = useSession.getState().identity;
      const me = await api('/v1/me', { schema: meSchema });
      if (stillCurrent(identity)) cacheMe(me); // a late answer for a previous user is not kept
      return me;
    },
  });
}

const BasisContext = createContext<UnitBasis>('mt');

/** The unit basis numbers are shown in; `mt` outside the app shell (and before `me` loads). */
export function useDisplayBasis(): UnitBasis {
  return useContext(BasisContext);
}

/** Reads and changes the user's unit basis. The change shows at once and is saved to the server. */
export function useUnitBasis(): { basis: UnitBasis; setBasis(b: UnitBasis): Promise<void> } {
  const qc = useQueryClient();
  const { data } = useMe();
  const basis = data?.preferences.unitBasis ?? 'mt';
  return {
    basis,
    async setBasis(b) {
      const identity = useSession.getState().identity;
      const prev = qc.getQueryData<Me>(ME_KEY);
      if (prev?.preferences.unitBasis === b) return;
      if (prev)
        qc.setQueryData<Me>(ME_KEY, {
          ...prev,
          preferences: { ...prev.preferences, unitBasis: b },
        });
      try {
        const me = await api('/v1/me/preferences', {
          method: 'PATCH',
          body: { unitBasis: b },
          schema: meSchema,
        });
        if (!stillCurrent(identity)) return; // signed out (or switched user) meanwhile
        qc.setQueryData(ME_KEY, me);
        cacheMe(me);
      } catch (e) {
        if (!stillCurrent(identity)) return;
        if (prev) qc.setQueryData(ME_KEY, prev);
        throw e;
      }
    },
  };
}

/**
 * Empties every query (cancelling those in flight) and the offline profile. Screens still open
 * refetch for the new person; with no one signed in, queries stay disabled and empty.
 */
export function resetClientData(qc: QueryClient): void {
  hideToast(); // a message meant for the previous person must not show to the next one
  void qc.cancelQueries();
  void qc.resetQueries();
  void AsyncStorage.removeItem(ME_CACHE_KEY).catch(() => undefined);
}

/**
 * App-wide data plumbing for the signed-in shell: provides the unit basis to every QtyText /
 * MoneyText, and on sign-out wipes cached server data (memory and the offline profile) so the
 * next person on this phone never sees the previous user's data.
 */
export function UnitBasisProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data } = useMe();

  useEffect(
    () =>
      useSession.subscribe((s, prev) => {
        // A different person (sign-out, sign-in, "Sign in as"): nothing fetched for the previous
        // one may survive — not in memory, not in the offline cache.
        if (s.identity !== prev.identity) resetClientData(qc);
      }),
    [qc],
  );

  return createElement(
    BasisContext.Provider,
    { value: data?.preferences.unitBasis ?? 'mt' },
    children,
  );
}
