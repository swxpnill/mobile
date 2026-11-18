import { useCompanies, usePlants } from '../../api/hooks/companies';
import { useMe } from '../../api/hooks/me';

/**
 * "Aarav Ispat Pvt Ltd · Siltara": the company and plant the signed-in person weighs at (canvas
 * header). Null until the names load; they stay cached when the phone goes offline.
 */
export function usePlantTitle(): string | null {
  const { data: me } = useMe();
  const { data: plants } = usePlants();
  const { data: companies } = useCompanies();
  if (!me || !plants) return null;
  const mine = plants.filter((p) => me.plantIds.includes(p.id));
  if (mine.length !== 1) return mine.length > 1 ? mine.map((p) => p.name).join(', ') : null;
  const plant = mine[0]!;
  const company = companies?.find((c) => c.id === plant.companyId);
  return company ? `${company.name} · ${plant.name}` : plant.name;
}

/** "1 weight", "2 weights". */
export const weights = (n: number) => `${n} ${n === 1 ? 'weight' : 'weights'}`;
