import { companySchema, plantSchema } from '@tonnage/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '../../auth/session';
import { api } from '../client';

const companiesSchema = z.array(companySchema);
const plantsSchema = z.array(plantSchema);

function useSignedIn(): boolean {
  const status = useSession((s) => s.status);
  return status === 'signedIn' || status === 'locked';
}

/** Companies the user may see (all for owner and city staff; their plants' companies otherwise). */
export function useCompanies() {
  return useQuery({
    queryKey: ['companies'],
    enabled: useSignedIn(),
    queryFn: () => api('/v1/companies', { schema: companiesSchema }),
  });
}

/** Plants in the user's scope. */
export function usePlants() {
  return useQuery({
    queryKey: ['plants'],
    enabled: useSignedIn(),
    queryFn: () => api('/v1/plants', { schema: plantsSchema }),
  });
}
