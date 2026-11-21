import { type Notification, type NotificationPage, notificationPageSchema, notificationSchema, unreadCountSchema } from '@tonnage/shared';
import { type InfiniteData, type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../auth/session';
import { api } from '../client';
import { currentIdentity, useSignedIn } from './cache';

/** Everything notification-shaped hangs off this prefix, so one invalidation refreshes list and badge. */
export const NOTIFICATIONS_KEY = ['notifications'] as const;
const LIST_KEY = [...NOTIFICATIONS_KEY, 'list'] as const;
const UNREAD_KEY = [...NOTIFICATIONS_KEY, 'unread'] as const;
/** The bell refreshes this often while the app is in the foreground. */
export const NOTIFICATION_COUNT_INTERVAL_MS = 60_000;

type Pages = InfiniteData<NotificationPage, string | null>;

/** The person's notifications, newest first, 30 a page (F5 Ruling 5). */
export function useNotifications() {
  return useInfiniteQuery({
    queryKey: LIST_KEY,
    enabled: useSignedIn(),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api(`/v1/notifications${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`, { schema: notificationPageSchema }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Unread count for the bell: on focus, every minute in the foreground, and after any change. */
export function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_KEY,
    enabled: useSignedIn(),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: NOTIFICATION_COUNT_INTERVAL_MS,
    refetchIntervalInBackground: false,
    queryFn: () => api('/v1/notifications/unread-count', { schema: unreadCountSchema }),
    select: (r) => r.count,
  });
}

/** New rows arrived (a push, a pull to refresh): list and badge fetch again. */
export function refreshNotifications(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
}

/**
 * Marks rows read in the cache at once (read state is not money, quantity or status, so it may
 * be optimistic), then confirms with the server. A late answer for a previous person is dropped.
 */
function markLocally(qc: QueryClient, ids: Set<string> | 'all', at: string): void {
  let changed = 0;
  qc.setQueryData<Pages>(LIST_KEY, (data) =>
    data && {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.map((n): Notification => {
          if (n.readAt !== null || (ids !== 'all' && !ids.has(n.id))) return n;
          changed += 1;
          return { ...n, readAt: at };
        }),
      })),
    },
  );
  // Only rows that really turned read move the badge; the refetch that follows settles the rest.
  qc.setQueryData<{ count: number }>(UNREAD_KEY, (c) => c && { count: ids === 'all' ? 0 : Math.max(0, c.count - changed) });
}

function useReadMutation<V>(send: (v: V) => Promise<unknown>, ids: (v: V) => Set<string> | 'all') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: V) => {
      const identity = currentIdentity();
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      markLocally(qc, ids(v), new Date(Date.now()).toISOString());
      try {
        await send(v);
      } finally {
        if (useSession.getState().identity === identity) void refreshNotifications(qc);
      }
    },
  });
}

export function useMarkRead() {
  return useReadMutation(
    (id: string) => api(`/v1/notifications/${id}/read`, { method: 'POST', schema: notificationSchema }),
    (id) => new Set([id]),
  );
}

export function useMarkAllRead() {
  return useReadMutation(
    () => api('/v1/notifications/read-all', { method: 'POST', schema: unreadCountSchema }),
    () => 'all',
  );
}
