import {
  type PartyBody,
  type PartyType,
  type ProductBody,
  type UpdatePartyBody,
  type UpdateProductBody,
  partySchema,
  partySummarySchema,
  productSchema,
} from '@tonnage/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../client';
import { currentIdentity, useSignedIn } from './cache';
import { useSession } from '../../auth/session';

/** `?a=1&b=x` from defined values only (RN's URLSearchParams is incomplete). */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string | number | boolean] => e[1] !== undefined && e[1] !== null && e[1] !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export interface PartyFilters {
  type?: PartyType;
  q?: string;
  active?: boolean;
}

export const PARTIES_KEY = ['parties'] as const;
export const partyKey = (id: string) => ['party', id] as const;
const partiesSchema = z.array(partySummarySchema);

export function useParties(filters: PartyFilters = {}) {
  return useQuery({
    queryKey: [...PARTIES_KEY, filters],
    enabled: useSignedIn(),
    // Typing in search keeps the last list on screen instead of flashing a spinner.
    placeholderData: keepPreviousData,
    queryFn: () => api(`/v1/parties${qs({ ...filters })}`, { schema: partiesSchema }),
  });
}

export function useParty(id: string | undefined) {
  return useQuery({
    queryKey: partyKey(id ?? ''),
    enabled: useSignedIn() && id !== undefined,
    queryFn: () => api(`/v1/parties/${id}`, { schema: partySchema }),
  });
}

/** Writes the saved party into its detail cache (same person only) and refreshes every list. */
function useSavedParty() {
  const qc = useQueryClient();
  return (p: z.infer<typeof partySchema>, identity: number) => {
    if (useSession.getState().identity !== identity) return;
    qc.setQueryData(partyKey(p.id), p);
    void qc.invalidateQueries({ queryKey: PARTIES_KEY });
  };
}

export function useCreateParty() {
  const saved = useSavedParty();
  return useMutation({
    mutationFn: async ({ body, key }: { body: PartyBody; key: string }) => {
      const identity = currentIdentity();
      const p = await api('/v1/parties', { method: 'POST', body, idempotencyKey: key, schema: partySchema });
      saved(p, identity);
      return p;
    },
  });
}

export function useUpdateParty() {
  const saved = useSavedParty();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: UpdatePartyBody }) => {
      const identity = currentIdentity();
      const p = await api(`/v1/parties/${id}`, { method: 'PATCH', body, schema: partySchema });
      saved(p, identity);
      return p;
    },
  });
}

export interface ProductFilters {
  category?: string;
  q?: string;
  companyId?: string;
  active?: boolean;
}

export const PRODUCTS_KEY = ['products'] as const;
export const productKey = (id: string) => ['product', id] as const;
const productsSchema = z.array(productSchema);

export function useProducts(filters: ProductFilters = {}) {
  return useQuery({
    queryKey: [...PRODUCTS_KEY, filters],
    enabled: useSignedIn(),
    placeholderData: keepPreviousData,
    queryFn: () => api(`/v1/products${qs({ ...filters })}`, { schema: productsSchema }),
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: productKey(id ?? ''),
    enabled: useSignedIn() && id !== undefined,
    queryFn: () => api(`/v1/products/${id}`, { schema: productSchema }),
  });
}

function useSavedProduct() {
  const qc = useQueryClient();
  return (p: z.infer<typeof productSchema>, identity: number) => {
    if (useSession.getState().identity !== identity) return;
    qc.setQueryData(productKey(p.id), p);
    void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
  };
}

export function useCreateProduct() {
  const saved = useSavedProduct();
  return useMutation({
    mutationFn: async ({ body, key }: { body: ProductBody; key: string }) => {
      const identity = currentIdentity();
      const p = await api('/v1/products', { method: 'POST', body, idempotencyKey: key, schema: productSchema });
      saved(p, identity);
      return p;
    },
  });
}

export function useUpdateProduct() {
  const saved = useSavedProduct();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: UpdateProductBody }) => {
      const identity = currentIdentity();
      const p = await api(`/v1/products/${id}`, { method: 'PATCH', body, schema: productSchema });
      saved(p, identity);
      return p;
    },
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const identity = currentIdentity();
      await api(`/v1/products/${id}`, { method: 'DELETE' });
      if (useSession.getState().identity !== identity) return;
      qc.removeQueries({ queryKey: productKey(id) });
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
    },
  });
}
