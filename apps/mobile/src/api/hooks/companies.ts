import {
  type Company,
  type CreateCompanyBody,
  companySchema,
  type UpdateCompanyBody,
} from '@tonnage/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../client';
import { currentIdentity, putInList, useSignedIn } from './cache';

export { usePlants } from './plants';

export const COMPANIES_KEY = ['companies'] as const;
const companiesSchema = z.array(companySchema);

/** Companies the user may see (all for owner and city staff; their plants' companies otherwise). */
export function useCompanies() {
  return useQuery({
    queryKey: COMPANIES_KEY,
    enabled: useSignedIn(),
    queryFn: () => api('/v1/companies', { schema: companiesSchema }),
  });
}

/** Companies sorted by code: the order unit tags and their colour slots follow (spec §8.4). */
export function byCode(list: readonly Company[]): Company[] {
  return [...list].sort((a, b) => a.code.localeCompare(b.code));
}

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, key }: { body: CreateCompanyBody; key: string }) => {
      const identity = currentIdentity();
      const c = await api('/v1/companies', {
        method: 'POST',
        body,
        idempotencyKey: key,
        schema: companySchema,
      });
      putInList(qc, COMPANIES_KEY, c, identity);
      return c;
    },
  });
}

export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateCompanyBody }) => {
      const identity = currentIdentity();
      const c = await api(`/v1/companies/${id}`, {
        method: 'PATCH',
        body: patch,
        schema: companySchema,
      });
      putInList(qc, COMPANIES_KEY, c, identity);
      return c;
    },
  });
}
