import { type TenantSettings, tenantSettingsSchema } from '@tonnage/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../client';
import { currentIdentity, useSignedIn } from './cache';

export const SETTINGS_KEY = ['settings'] as const;

/** Business-wide rules (tolerance, aged-order days, pricing…). Everyone may read them. */
export function useTenantSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    enabled: useSignedIn(),
    queryFn: () => api('/v1/settings', { schema: tenantSettingsSchema }),
  });
}

/** Owner only. Sends just the changed keys; the server merges and returns the whole set. */
export function useUpdateTenantSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<TenantSettings>) => {
      const identity = currentIdentity();
      const s = await api('/v1/settings', {
        method: 'PATCH',
        body: patch,
        schema: tenantSettingsSchema,
      });
      if (currentIdentity() === identity) qc.setQueryData(SETTINGS_KEY, s);
      return s;
    },
  });
}
