import {
  type AssignTruckBody,
  type CancelTruckBody,
  type DispatchQuery,
  type EditTruckBody,
  type Truck,
  dispatchBoardSchema,
  recentVehicleSchema,
  truckSchema,
} from '@tonnage/shared';
import {
  type QueryClient, keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '../../auth/session';
import { useUnitFilter } from '../../prefs/unitFilter';
import { ApiError, api } from '../client';
import { currentIdentity, useSignedIn } from './cache';
import { PARTIES_KEY, qs } from './masters';
import { DISPATCH_KEY, HOME_KEY, ORDERS_KEY, TRUCK_KEY, orderKey } from './orders';

export const truckKey = (id: string) => [...TRUCK_KEY, id] as const;
export const RECENT_VEHICLES_KEY = ['recent-vehicles'] as const;

export type DispatchState = DispatchQuery['state'];

/** The board for the unit switcher's choice; the key includes it, so switching refetches. */
export function useDispatchBoard(f: { state: DispatchState; q: string }) {
  const { companyId } = useUnitFilter();
  const q = f.q.trim();
  return useQuery({
    queryKey: [...DISPATCH_KEY, companyId, f.state, q],
    enabled: useSignedIn(),
    placeholderData: keepPreviousData,
    queryFn: () =>
      api(
        `/v1/dispatch${qs({ companyId: companyId === 'all' ? undefined : companyId, state: f.state, q: q || undefined })}`,
        { schema: dispatchBoardSchema },
      ),
  });
}

export function useTruck(id: string | undefined) {
  return useQuery({
    queryKey: truckKey(id ?? ''),
    enabled: useSignedIn() && id !== undefined,
    queryFn: () => api(`/v1/trucks/${id}`, { schema: truckSchema }),
  });
}

export function useRecentVehicles(enabled = true) {
  return useQuery({
    queryKey: RECENT_VEHICLES_KEY,
    enabled: useSignedIn() && enabled,
    queryFn: () => api('/v1/trucks/recent-vehicles', { schema: z.array(recentVehicleSchema) }),
  });
}

/**
 * After any truck change: the server's truck into its detail cache, then refetch everything that
 * shows trucks or quantities (board, Home, orders, that order, transporter stats) or money a
 * dispatch earns or a correction rewrites (broker dues and ledgers, reports). Skipped for a
 * late answer after a person switch.
 */
export function afterTruckChange(qc: QueryClient, identity: number, truck?: Truck): void {
  if (useSession.getState().identity !== identity) return;
  if (truck) qc.setQueryData(truckKey(truck.id), truck);
  const keys: readonly (readonly string[])[] = [DISPATCH_KEY, HOME_KEY, ORDERS_KEY, PARTIES_KEY, RECENT_VEHICLES_KEY, ['order-activity'], ['party'], ['broker'], ['report']];
  for (const key of truck ? [...keys, orderKey(truck.orderId)] : keys) void qc.invalidateQueries({ queryKey: key });
}

function useTruckMutation<V>(run: (v: V) => Promise<Truck>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: V) => {
      const identity = currentIdentity();
      const truck = await run(v);
      afterTruckChange(qc, identity, truck);
      return truck;
    },
    onError: (e) => {
      // Someone else changed it: fetch the latest so the next try carries its version.
      if (e instanceof ApiError && (e.code === 'STALE' || e.code === 'TRUCK_LOCKED' || e.code === 'NOT_AWAITING_APPROVAL')) {
        void qc.invalidateQueries({ queryKey: TRUCK_KEY });
        void qc.invalidateQueries({ queryKey: DISPATCH_KEY });
      }
    },
  });
}

/** Assign (idempotent: the caller holds one key across retries of one submit). */
export const useAssignTruck = () =>
  useTruckMutation(({ subOrderId, body, key }: { subOrderId: string; body: AssignTruckBody; key: string }) =>
    api(`/v1/sub-orders/${subOrderId}/trucks`, { method: 'POST', body, idempotencyKey: key, schema: truckSchema }),
  );

/**
 * Edit and cancel: versioned, and keyed like every write from the phone. The caller holds one key
 * per submit (`useSubmitKey`) and reuses it on a retry after a lost answer.
 */
export const useEditTruck = () =>
  useTruckMutation(({ id, body, key }: { id: string; body: EditTruckBody; key: string }) =>
    api(`/v1/trucks/${id}`, { method: 'PATCH', body, idempotencyKey: key, schema: truckSchema }),
  );

/** TON-57: the office approves a weighed truck; that is the dispatch (slip, earning). Keyed and versioned. */
export const useApproveTruck = () =>
  useTruckMutation(({ id, version, key }: { id: string; version: number; key: string }) =>
    api(`/v1/trucks/${id}/approve`, { method: 'POST', body: { version }, idempotencyKey: key, schema: truckSchema }),
  );

export const useCancelTruck = () =>
  useTruckMutation(({ id, body, key }: { id: string; body: CancelTruckBody; key: string }) =>
    api(`/v1/trucks/${id}/cancel`, { method: 'POST', body, idempotencyKey: key, schema: truckSchema }),
  );
