import { type InviteUserBody, type UpdateUserBody, userSchema } from '@tonnage/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../client';
import { currentIdentity, putInList, useSignedIn } from './cache';

export const USERS_KEY = ['users'] as const;
const usersSchema = z.array(userSchema);

/** Everyone in the business (owner only; `users.manage`). */
export function useUsers(enabled = true) {
  return useQuery({
    queryKey: USERS_KEY,
    enabled: useSignedIn() && enabled,
    queryFn: () => api('/v1/users', { schema: usersSchema }),
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, key }: { body: InviteUserBody; key: string }) => {
      const identity = currentIdentity();
      const u = await api('/v1/users', {
        method: 'POST',
        body,
        idempotencyKey: key,
        schema: userSchema,
      });
      putInList(qc, USERS_KEY, u, identity);
      return u;
    },
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateUserBody }) => {
      const identity = currentIdentity();
      const u = await api(`/v1/users/${id}`, { method: 'PATCH', body: patch, schema: userSchema });
      putInList(qc, USERS_KEY, u, identity);
      return u;
    },
  });
}

/** Deactivate (signs them out everywhere) or reactivate. Both are safe to repeat. */
export function useSetUserActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const identity = currentIdentity();
      const u = await api(`/v1/users/${id}/${active ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        schema: userSchema,
      });
      putInList(qc, USERS_KEY, u, identity);
      return u;
    },
  });
}
