import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useSession } from '../../auth/session';

export function useSignedIn(): boolean {
  const status = useSession((s) => s.status);
  return status === 'signedIn' || status === 'locked';
}

/**
 * Puts a saved record into its cached list (replacing by id, or appending), then marks the list
 * stale so it is refetched in the background. Skipped when the person signed out or switched
 * meanwhile: a late answer for a previous user must never land in the new user's cache.
 */
export function putInList<T extends { id: string }>(
  qc: QueryClient,
  key: QueryKey,
  item: T,
  identity: number,
): void {
  if (useSession.getState().identity !== identity) return;
  qc.setQueryData<T[]>(key, (list) => {
    if (!list) return list;
    return list.some((x) => x.id === item.id)
      ? list.map((x) => (x.id === item.id ? item : x))
      : [...list, item];
  });
  void qc.invalidateQueries({ queryKey: key });
}

export const currentIdentity = () => useSession.getState().identity;
