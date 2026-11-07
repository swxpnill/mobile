import {
  type CreateOrderBody,
  type MoveQuantityBody,
  type OrderListStatus,
  type ShortCloseBody,
  type UpdateOrderBody,
  activityEntrySchema,
  deletePreviewSchema,
  draftSchema,
  homeSchema,
  orderListSchema,
  orderSchema,
} from '@tonnage/shared';
import {
  type QueryClient,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '../../auth/session';
import { useUnitFilter } from '../../prefs/unitFilter';
import { ApiError, api } from '../client';
import { currentIdentity, useSignedIn } from './cache';
import { PARTIES_KEY, qs } from './masters';

export const ORDERS_KEY = ['orders'] as const;
export const HOME_KEY = ['home'] as const;
export const DRAFTS_KEY = ['drafts'] as const;
export const orderKey = (id: string) => ['order', id] as const;

export interface OrderFilters {
  status?: OrderListStatus;
  q?: string;
  sort?: 'newest' | 'oldest';
  aged?: boolean;
}

const filterParam = (companyId: string) => (companyId === 'all' ? undefined : companyId);

/** Home figures for the unit switcher's choice; the key includes it, so switching refetches. */
export function useHome() {
  return useHomeFor(useUnitFilter().companyId);
}

/** Home figures for one company or all of them (the unit switcher lists every unit's pending). */
export function useHomeFor(companyId: string) {
  return useQuery({
    queryKey: [...HOME_KEY, companyId],
    enabled: useSignedIn(),
    placeholderData: keepPreviousData,
    queryFn: () => api(`/v1/home${qs({ companyId: filterParam(companyId) })}`, { schema: homeSchema }),
  });
}

/** Orders, page by page (20), filtered by the unit switcher plus the screen's own filters. */
export function useOrders(filters: OrderFilters = {}) {
  const { companyId } = useUnitFilter();
  const f = { status: filters.status ?? 'all', q: filters.q?.trim() || undefined, sort: filters.sort ?? 'newest', aged: filters.aged };
  return useInfiniteQuery({
    queryKey: [...ORDERS_KEY, companyId, f.status, f.q ?? '', f.sort, f.aged ?? null],
    enabled: useSignedIn(),
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api(
        `/v1/orders${qs({ status: f.status, q: f.q, sort: f.sort, aged: f.aged, companyId: filterParam(companyId), cursor: pageParam })}`,
        { schema: orderListSchema },
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useOrder(id: string | undefined) {
  return useQuery({
    queryKey: orderKey(id ?? ''),
    enabled: useSignedIn() && id !== undefined,
    queryFn: () => api(`/v1/orders/${id}`, { schema: orderSchema }),
  });
}

export function useOrderActivity(id: string, enabled = true) {
  return useQuery({
    queryKey: ['order-activity', id],
    enabled: useSignedIn() && enabled,
    queryFn: () => api(`/v1/orders/${id}/activity`, { schema: z.array(activityEntrySchema) }),
  });
}

export function useDeletePreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['order-delete-preview', id],
    enabled: useSignedIn() && enabled,
    staleTime: 0,
    queryFn: () => api(`/v1/orders/${id}/delete-preview`, { schema: deletePreviewSchema }),
  });
}

/**
 * After any order change: put the server's answer in the detail cache and refetch everything
 * that shows order figures (lists, Home, party pending). Never optimistic: quantities, money and
 * status only ever come from the server (spec §8.2). Skipped for a late answer after a switch.
 */
export function afterOrderChange(qc: QueryClient, identity: number, order?: z.infer<typeof orderSchema>): void {
  if (useSession.getState().identity !== identity) return;
  if (order) qc.setQueryData(orderKey(order.id), order);
  for (const key of [ORDERS_KEY, HOME_KEY, PARTIES_KEY, DRAFTS_KEY, ['order-activity']]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

function useOrderMutation<V>(run: (v: V) => Promise<z.infer<typeof orderSchema>>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: V) => {
      const identity = currentIdentity();
      const order = await run(v);
      afterOrderChange(qc, identity, order);
      return order;
    },
    onError: (e) => {
      // Someone else changed it: fetch the latest so "Showing the latest" is true and the next try has its version.
      if (e instanceof ApiError && e.code === 'STALE') {
        void qc.invalidateQueries({ queryKey: ['order'] });
        void qc.invalidateQueries({ queryKey: ['order-activity'] });
      }
    },
  });
}

export const useCreateOrder = () =>
  useOrderMutation(({ body, key }: { body: CreateOrderBody; key: string }) =>
    api('/v1/orders', { method: 'POST', body, idempotencyKey: key, schema: orderSchema }),
  );

export const useUpdateOrder = () =>
  useOrderMutation(({ id, body }: { id: string; body: UpdateOrderBody }) =>
    api(`/v1/orders/${id}`, { method: 'PATCH', body, schema: orderSchema }),
  );

export const useShortClose = () =>
  useOrderMutation(({ subOrderId, body }: { subOrderId: string; body: ShortCloseBody }) =>
    api(`/v1/sub-orders/${subOrderId}/short-close`, { method: 'POST', body, schema: orderSchema }),
  );

export const useReopen = () =>
  useOrderMutation(({ subOrderId, version }: { subOrderId: string; version: number }) =>
    api(`/v1/sub-orders/${subOrderId}/reopen`, { method: 'POST', body: { version }, schema: orderSchema }),
  );

export const useMoveQuantity = () =>
  useOrderMutation(({ orderId, body }: { orderId: string; body: MoveQuantityBody }) =>
    api(`/v1/orders/${orderId}/move-quantity`, { method: 'POST', body, schema: orderSchema }),
  );

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, confirmNumber }: { id: string; confirmNumber: string }) => {
      const identity = currentIdentity();
      await api(`/v1/orders/${id}`, { method: 'DELETE', body: { confirmNumber } });
      if (useSession.getState().identity !== identity) return;
      qc.removeQueries({ queryKey: orderKey(id) });
      afterOrderChange(qc, identity);
    },
  });
}

const draftsSchema = z.array(draftSchema);

export function useDrafts(enabled = true) {
  return useQuery({
    queryKey: DRAFTS_KEY,
    enabled: useSignedIn() && enabled,
    queryFn: () => api('/v1/orders/drafts', { schema: draftsSchema }),
  });
}

export function useDraft(id: string | undefined) {
  return useQuery({
    queryKey: [...DRAFTS_KEY, id],
    enabled: useSignedIn() && id !== undefined,
    staleTime: Infinity,
    queryFn: () => api(`/v1/orders/drafts/${id}`, { schema: draftSchema }),
  });
}

/** Draft writes: create (idempotent), save (versioned), delete, and duplicate-an-order-to-draft. */
export function useDraftApi() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: DRAFTS_KEY, exact: true });
  // Keep the resume cache (staleTime Infinity) on the version the server has, or a resumed draft starts STALE.
  const keep = (d: z.infer<typeof draftSchema>) => qc.setQueryData([...DRAFTS_KEY, d.id], d);
  return {
    create: async (payload: Record<string, unknown>, key: string) => {
      const d = await api('/v1/orders/drafts', { method: 'POST', body: { payload }, idempotencyKey: key, schema: draftSchema });
      keep(d);
      refresh();
      return d;
    },
    save: async (id: string, payload: Record<string, unknown>, version: number) => {
      const d = await api(`/v1/orders/drafts/${id}`, { method: 'PUT', body: { payload, version }, schema: draftSchema });
      keep(d);
      refresh();
      return d;
    },
    load: (id: string) => api(`/v1/orders/drafts/${id}`, { schema: draftSchema }),
    remove: async (id: string) => {
      await api(`/v1/orders/drafts/${id}`, { method: 'DELETE' });
      qc.removeQueries({ queryKey: [...DRAFTS_KEY, id], exact: true });
      refresh();
    },
    duplicate: async (orderId: string, key: string) => {
      const d = await api(`/v1/orders/${orderId}/duplicate`, { method: 'POST', idempotencyKey: key, schema: draftSchema });
      refresh();
      return d;
    },
  };
}
