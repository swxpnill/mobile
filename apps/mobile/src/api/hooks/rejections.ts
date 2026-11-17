import {
  type CorrectWeightBody,
  type Rejection,
  type Truck,
  rejectionCountSchema,
  rejectionSchema,
  restoreRejectionResultSchema,
  truckSchema,
} from '@tonnage/shared';
import { type QueryClient, keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { useSession } from '../../auth/session';
import { ApiError, api } from '../client';
import { currentIdentity, useSignedIn } from './cache';
import { useMe } from './me';
import { DISPATCH_KEY, TRUCK_KEY } from './orders';
import { afterTruckChange } from './trucks';

export const REJECTIONS_KEY = ['weighment-rejections'] as const;
export const REJECTION_COUNT_KEY = ['weighment-rejections-count'] as const;
export type RejectionFilter = 'open' | 'all';

/** Owner only (`rejections.manage`): other roles never ask, so the API's 403 never shows. */
function useOwnerOnly(): boolean {
  const { data: me } = useMe();
  return useSignedIn() && me?.role === 'owner';
}

/** The badge refreshes this often while the app is in the foreground (owner only). */
export const REJECTION_COUNT_INTERVAL_MS = 60_000;

/** Loading the list also settles the badge: the open list is the count; "all" asks again. */
export function useRejections(status: RejectionFilter) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...REJECTIONS_KEY, status],
    enabled: useOwnerOnly(),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const identity = currentIdentity();
      const items = await api(`/v1/weighment-rejections?status=${status}`, { schema: z.array(rejectionSchema) });
      if (useSession.getState().identity === identity) {
        if (status === 'open') qc.setQueryData(REJECTION_COUNT_KEY, { open: items.length });
        else void qc.invalidateQueries({ queryKey: REJECTION_COUNT_KEY });
      }
      return items;
    },
  });
}

/**
 * The open count for the badge on More. Refusals come from other phones' syncs, so it is
 * refetched on foreground, every minute while the app is open, when More gains focus
 * (`useRejectionsOnFocus`) and after each sync run on this phone (`refreshRejections`).
 */
export function useRejectionCount() {
  return useQuery({
    queryKey: REJECTION_COUNT_KEY,
    enabled: useOwnerOnly(),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: REJECTION_COUNT_INTERVAL_MS,
    refetchIntervalInBackground: false,
    queryFn: () => api('/v1/weighment-rejections/count', { schema: rejectionCountSchema }),
  });
}

/** The More tab: refetch the badge each time it gains focus (it stays mounted as a tab). */
export function useRejectionsOnFocus(): void {
  const qc = useQueryClient();
  useFocusEffect(
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: REJECTION_COUNT_KEY });
    }, [qc]),
  );
}

/**
 * List and count again: after a restore or dismiss (or a refusal that says the list is out of
 * date), and after every completed sync run on this phone. Skipped after a person switch.
 */
export function refreshRejections(qc: QueryClient, identity: number): void {
  if (useSession.getState().identity !== identity) return;
  void qc.invalidateQueries({ queryKey: REJECTIONS_KEY });
  void qc.invalidateQueries({ queryKey: REJECTION_COUNT_KEY });
}

/**
 * Restore and dismiss. Neither route is idempotent on the server (a second try is refused with
 * ALREADY_RESOLVED), but every write from the phone carries a key: the caller holds one per submit.
 */
export function useResolveRejection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      v: { id: string; key: string } & ({ kind: 'restore' } | { kind: 'dismiss'; reason: string }),
    ): Promise<{ truck?: Truck; rejection: Rejection }> => {
      const identity = currentIdentity();
      try {
        if (v.kind === 'restore') {
          const r = await api(`/v1/weighment-rejections/${v.id}/restore`, {
            method: 'POST',
            idempotencyKey: v.key,
            schema: restoreRejectionResultSchema,
          });
          afterTruckChange(qc, identity, r.truck);
          return r;
        }
        const rejection = await api(`/v1/weighment-rejections/${v.id}/dismiss`, {
          method: 'POST',
          body: { reason: v.reason },
          idempotencyKey: v.key,
          schema: rejectionSchema,
        });
        return { rejection };
      } finally {
        // Resolved, already resolved, or refused again: the list and count say where it stands.
        refreshRejections(qc, identity);
      }
    },
  });
}

/** Owner's weight correction on a dispatched truck: versioned, keyed per submit. */
export function useCorrectWeight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body, key }: { id: string; body: CorrectWeightBody; key: string }) => {
      const identity = currentIdentity();
      const truck = await api(`/v1/trucks/${id}/correct-weight`, {
        method: 'POST',
        body,
        idempotencyKey: key,
        schema: truckSchema,
      });
      afterTruckChange(qc, identity, truck);
      return truck;
    },
    onError: (e) => {
      // Someone else changed the truck: fetch the latest so the next try carries its version.
      if (e instanceof ApiError && (e.code === 'STALE' || e.code === 'TRUCK_LOCKED')) {
        void qc.invalidateQueries({ queryKey: TRUCK_KEY });
        void qc.invalidateQueries({ queryKey: DISPATCH_KEY });
      }
    },
  });
}
