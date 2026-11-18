import {
  type RecordPaymentBody,
  brokerDuesSchema,
  brokerLedgerSchema,
  brokerStatementSchema,
  can,
  paymentResultSchema,
} from '@tonnage/shared';
import { type QueryClient, keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../auth/session';
import { api } from '../client';
import { currentIdentity, useSignedIn } from './cache';
import { qs } from './masters';
import { useMe } from './me';

/** Everything about broker money (dues, ledgers, statements) sits under this key. */
export const BROKER_KEY = ['broker'] as const;
/** Reports (Task 8) include broker earnings and payments. */
export const REPORT_KEY = ['report'] as const;
export const BROKER_DUES_KEY = ['broker', 'dues'] as const;

export type LedgerView = 'all' | 'earnings' | 'payments';

/** Money reads are for `money.view` roles only; others never ask, so no 403 ever shows. */
function useMoneyRole(): boolean {
  const { data: me } = useMe();
  return useSignedIn() && me !== undefined && can(me.role, 'money.view');
}

/** After a payment or reversal: dues, ledgers, statements and reports all move. */
export function afterMoneyChange(qc: QueryClient, identity: number): void {
  if (useSession.getState().identity !== identity) return;
  void qc.invalidateQueries({ queryKey: BROKER_KEY });
  void qc.invalidateQueries({ queryKey: REPORT_KEY });
}

export function useBrokerDues() {
  return useQuery({
    queryKey: BROKER_DUES_KEY,
    enabled: useMoneyRole(),
    queryFn: () => api('/v1/brokers/dues', { schema: brokerDuesSchema }),
  });
}

/** One broker's ledger, newest first, 50 a page; the next page starts `before` the last item. */
export function useBrokerLedger(id: string, view: LedgerView) {
  return useInfiniteQuery({
    queryKey: ['broker', id, 'ledger', view],
    enabled: useMoneyRole(),
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api(`/v1/brokers/${id}/ledger${qs({ view, before: pageParam })}`, { schema: brokerLedgerSchema }),
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useBrokerStatement(id: string, range: { from: string; to: string }, enabled = true) {
  return useQuery({
    queryKey: ['broker', id, 'statement', range.from, range.to],
    enabled: useMoneyRole() && enabled,
    queryFn: () => api(`/v1/brokers/${id}/statement${qs(range)}`, { schema: brokerStatementSchema }),
  });
}

/** Idempotent: the caller holds one key across retries of one submit (`useSubmitKey`). */
export function useRecordPayment(brokerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, key }: { body: RecordPaymentBody; key: string }) => {
      const identity = currentIdentity();
      const r = await api(`/v1/brokers/${brokerId}/payments`, {
        method: 'POST',
        body,
        idempotencyKey: key,
        schema: paymentResultSchema,
      });
      afterMoneyChange(qc, identity);
      return r;
    },
  });
}

export function useReversePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, reason, key }: { entryId: string; reason: string; key: string }) => {
      const identity = currentIdentity();
      try {
        return await api(`/v1/ledger/${entryId}/reverse`, {
          method: 'POST',
          body: { reason },
          idempotencyKey: key,
          schema: paymentResultSchema,
        });
      } finally {
        // Reversed, or refused as already reversed: the ledger says where it stands either way.
        afterMoneyChange(qc, identity);
      }
    },
  });
}
