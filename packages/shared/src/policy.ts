import type { Role } from './roles.ts';

export const ACTIONS = [
  'order.create', 'order.edit', 'order.duplicate', 'order.shortClose', 'order.reopen',
  'order.editDispatched', 'order.hardDelete', 'order.view',
  'truck.assign', 'truck.edit', 'truck.cancel',
  'weighment.capture', 'weighment.correctAfterDispatch', 'rejections.manage',
  'dispatch.view', 'tasks.view', 'masters.manage', 'import.run', 'broker.pay',
  'reports.view', 'reports.doneToday', 'money.view',
  'users.manage', 'companies.manage', 'settings.manage', 'self.view',
] as const;
export type Action = (typeof ACTIONS)[number];

const ALLOWED: Record<Role, ReadonlySet<Action>> = {
  owner: new Set<Action>(ACTIONS),
  city_staff: new Set<Action>([
    'order.create', 'order.edit', 'order.duplicate', 'order.shortClose', 'order.view',
    'truck.assign', 'truck.edit', 'truck.cancel', 'dispatch.view', 'masters.manage',
    'import.run', 'broker.pay', 'reports.view', 'money.view', 'self.view',
  ]),
  plant_head: new Set<Action>(['order.view', 'dispatch.view', 'self.view']),
  supervisor: new Set<Action>(['weighment.capture', 'tasks.view', 'reports.doneToday', 'self.view']),
};

export function can(role: Role, action: Action): boolean {
  return ALLOWED[role].has(action);
}

export function scopeKind(role: Role): 'all' | 'plants' {
  return role === 'owner' || role === 'city_staff' ? 'all' : 'plants';
}

export function plantRule(role: Role): { min: number; max: number } {
  switch (role) {
    case 'owner':
    case 'city_staff':
      return { min: 0, max: 0 };
    case 'plant_head':
      return { min: 1, max: Infinity };
    case 'supervisor':
      return { min: 1, max: 1 };
  }
}

const NO_MONEY = 'See rates, order values or broker money';

/** Invite-screen copy. Strings may contain {plant}. Fresh arrays on every call. */
export function describeRole(role: Role): { can: string[]; cannot: string[] } {
  switch (role) {
    case 'supervisor':
      return {
        can: ['See trucks assigned to {plant}', 'Capture tare and gross weight, works offline'],
        cannot: [NO_MONEY, 'Create orders or assign vehicles'],
      };
    case 'plant_head':
      return {
        can: ['See orders and dispatch of {plant}'],
        cannot: [NO_MONEY, 'Create or edit orders, assign vehicles or weigh trucks'],
      };
    case 'city_staff':
      return {
        can: [
          'Create and edit orders for any unit',
          'Assign vehicles',
          'Manage parties and products',
          'Record broker payments',
          'See reports',
        ],
        cannot: ['Delete orders', 'Change settings or users'],
      };
    case 'owner':
      return { can: ['Everything, including delete and settings'], cannot: [] };
  }
}

export type PlantScope = { kind: 'all' } | { kind: 'plants'; plantIds: string[] };

/** Row scope for a user: owner/city_staff see everything; plant roles only their plants. */
export function plantScope(user: { role: Role; plantIds: readonly string[] }): PlantScope {
  return scopeKind(user.role) === 'all'
    ? { kind: 'all' }
    : { kind: 'plants', plantIds: [...user.plantIds] };
}
