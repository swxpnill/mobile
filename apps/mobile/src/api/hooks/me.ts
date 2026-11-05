import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Me, type UnitBasis, meSchema } from '@tonnage/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useContext, useEffect } from 'react';
import { useSession } from '../../auth/session';
import { api } from '../client';

/** Last known profile, so the app can open on the right tabs without the network. */
export const ME_CACHE_KEY = 'tonnage.me';
export const ME_KEY = ['me'] as const;

function cacheMe(me: Me): void {
  void AsyncStorage.setItem(ME_CACHE_KEY, JSON.stringify(me)).catch(() => undefined);
}

/** The signed-in user (`/v1/me`), refetched on focus, seeded from the offline cache. */
export function useMe() {
  const qc = useQueryClient();
  const status = useSession((s) => s.status);
  const enabled = status === 'signedIn' || status === 'locked';

  useEffect(() => {
    if (!enabled || qc.getQueryData(ME_KEY)) return;
    void AsyncStorage.getItem(ME_CACHE_KEY)
      .then((raw) => {
        const parsed = raw ? meSchema.safeParse(JSON.parse(raw)) : null;
        // updatedAt 0: shown at once, but always refetched.
        if (parsed?.success && !qc.getQueryData(ME_KEY)) {
          qc.setQueryData(ME_KEY, parsed.data, { updatedAt: 0 });
        }
      })
      .catch(() => undefined);
  }, [enabled, qc]);

  return useQuery({
    queryKey: ME_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const me = await api('/v1/me', { schema: meSchema });
      cacheMe(me);
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
        qc.setQueryData(ME_KEY, me);
        cacheMe(me);
      } catch (e) {
        if (prev) qc.setQueryData(ME_KEY, prev);
        throw e;
      }
    },
  };
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
        if (s.status === 'signedOut' && prev.status !== 'signedOut') {
          qc.clear();
          void AsyncStorage.removeItem(ME_CACHE_KEY).catch(() => undefined);
        }
      }),
    [qc],
  );

  return createElement(
    BasisContext.Provider,
    { value: data?.preferences.unitBasis ?? 'mt' },
    children,
  );
}
