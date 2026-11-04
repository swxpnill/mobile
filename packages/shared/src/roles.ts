export const ROLES = ['owner', 'city_staff', 'plant_head', 'supervisor'] as const;
export type Role = (typeof ROLES)[number];
