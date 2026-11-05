import { type CreatePlantBody, plantSchema, type UpdatePlantBody } from '@tonnage/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../client';
import { currentIdentity, putInList, useSignedIn } from './cache';

export const PLANTS_KEY = ['plants'] as const;
const plantsSchema = z.array(plantSchema);

/** Plants in the user's scope. */
export function usePlants() {
  return useQuery({
    queryKey: PLANTS_KEY,
    enabled: useSignedIn(),
    queryFn: () => api('/v1/plants', { schema: plantsSchema }),
  });
}

export function useCreatePlant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, key }: { body: CreatePlantBody; key: string }) => {
      const identity = currentIdentity();
      const p = await api('/v1/plants', {
        method: 'POST',
        body,
        idempotencyKey: key,
        schema: plantSchema,
      });
      putInList(qc, PLANTS_KEY, p, identity);
      return p;
    },
  });
}

export function useUpdatePlant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdatePlantBody }) => {
      const identity = currentIdentity();
      const p = await api(`/v1/plants/${id}`, {
        method: 'PATCH',
        body: patch,
        schema: plantSchema,
      });
      putInList(qc, PLANTS_KEY, p, identity);
      return p;
    },
  });
}
