import type { Company, Plant, Role } from '@tonnage/shared';

/** Role names as the client says them (decisions doc), used in badges and profile lines. */
export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  city_staff: 'City staff / Accounts',
  plant_head: 'Plant head',
  supervisor: 'Loading supervisor',
};

/** Short role names for badges in lists, where the full name would crowd the row. */
export const ROLE_SHORT: Record<Role, string> = {
  owner: 'Owner',
  city_staff: 'City staff',
  plant_head: 'Plant head',
  supervisor: 'Supervisor',
};

/** "Aarav Ispat Pvt Ltd" → "Aarav": the short company name the canvas uses next to a plant. */
export function shortCompanyName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** "all 4 units" for roles that see everything; "Aarav · Siltara" for plant roles. */
export function scopeLine(
  role: Role,
  plantIds: string[],
  companies: Company[] | undefined,
  plants: Plant[] | undefined,
): string {
  if (role === 'owner' || role === 'city_staff') {
    return companies ? `all ${companies.length} units` : 'all units';
  }
  const names = plantIds.map((id) => {
    const p = plants?.find((x) => x.id === id);
    if (!p) return '';
    const c = companies?.find((x) => x.id === p.companyId);
    return c ? `${shortCompanyName(c.name)} · ${p.name}` : p.name;
  });
  return names.filter(Boolean).join(', ');
}
