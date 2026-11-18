import { type Report, type ReportKind, can, reportSchema } from '@tonnage/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { api } from '../client';
import { useSignedIn } from './cache';
import { qs } from './masters';
import { useMe } from './me';
import { REPORT_KEY } from './money';

/** A report's query: the range always (the schema needs it, even for pending orders), plus filters. */
export interface ReportParams {
  from: string;
  to: string;
  companyId?: string;
  customerId?: string;
  brokerId?: string;
  plantId?: string;
  bucket?: string;
}

/**
 * `GET /v1/reports/:kind` for `reports.view` roles only (others never ask, so no 403 shows).
 * Switching range or filter keeps the same kind's last report on screen while the next loads;
 * switching kind does not, since another kind's numbers would mislead. Refetched when the screen
 * regains focus; payments and truck changes invalidate `['report']` too.
 */
export function useReport(kind: ReportKind, f: ReportParams, enabled = true) {
  const { data: me } = useMe();
  const allowed = useSignedIn() && me !== undefined && can(me.role, 'reports.view');
  const { from, to, companyId, ...extra } = f;
  const qc = useQueryClient();
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      // The first focus is the mount, which fetches anyway.
      if (focused.current) void qc.invalidateQueries({ queryKey: REPORT_KEY });
      focused.current = true;
    }, [qc]),
  );
  return useQuery({
    queryKey: [...REPORT_KEY, kind, companyId ?? 'all', from, to, extra],
    enabled: allowed && enabled,
    placeholderData: (prev: Report | undefined) => (prev?.kind === kind ? prev : undefined),
    queryFn: () => api(`/v1/reports/${kind}${qs({ from, to, companyId, ...extra })}`, { schema: reportSchema }),
  });
}
