import type { Role } from '@tonnage/shared';
import type { IconName } from '../ui/Icon';

export type TabKey = 'home' | 'orders' | 'new' | 'dispatch' | 'more' | 'tasks' | 'done' | 'profile';

/** Bottom tabs per role (spec §8.1, canvas). Plant heads cannot create orders, so no "New". */
export function tabsForRole(role: Role): TabKey[] {
  switch (role) {
    case 'owner':
    case 'city_staff':
      return ['home', 'orders', 'new', 'dispatch', 'more'];
    case 'plant_head':
      return ['home', 'orders', 'dispatch', 'more'];
    case 'supervisor':
      return ['tasks', 'done', 'profile'];
  }
}

export function firstTab(role: Role): TabKey {
  return tabsForRole(role)[0]!;
}

export const TAB_META: Record<TabKey, { label: string; icon: IconName }> = {
  home: { label: 'Home', icon: 'grid' },
  orders: { label: 'Orders', icon: 'orders' },
  new: { label: 'New', icon: 'plus' },
  dispatch: { label: 'Dispatch', icon: 'truck' },
  more: { label: 'More', icon: 'menu' },
  tasks: { label: 'My tasks', icon: 'scales' },
  done: { label: 'Done', icon: 'check' },
  profile: { label: 'Profile', icon: 'user' },
};
