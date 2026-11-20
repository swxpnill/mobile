import { can } from '../policy.ts';
import type { Role } from '../roles.ts';
import type { NotificationKind } from './kinds.ts';

export interface NotifyEvent {
  kind: NotificationKind;
  /** Who caused it; never told about their own action. `'system'` for jobs. */
  actorId: string;
  /** Plants the event touches (the truck's plant, the plants of the order's companies). */
  plantIds: readonly string[];
  /** The order's creator: told about their own order's over-loading and short close. */
  orderCreatorId?: string;
}

export interface RecipientUser {
  id: string;
  role: Role;
  active: boolean;
  plantIds: readonly string[];
}

export interface Recipient {
  userId: string;
  role: Role;
  /**
   * `alert`: a list row and a phone notification. `row-and-sync`: also a silent sync push
   * (supervisors' tasks changed). `row`: the list row only, no push at all (TON-57 Ruling 21:
   * the office is not buzzed for every truck that arrives; the bell still counts it).
   */
  delivery: 'alert' | 'row-and-sync' | 'row';
}

type Rule = (u: RecipientUser, e: NotifyEvent, atPlant: boolean) => Recipient['delivery'] | null;

const creator = (u: RecipientUser, e: NotifyEvent) => u.role === 'city_staff' && u.id === e.orderCreatorId;
const owner = (u: RecipientUser) => u.role === 'owner';
const plantHeadHere = (u: RecipientUser, atPlant: boolean) => u.role === 'plant_head' && atPlant;
const alertIf = (yes: boolean) => (yes ? 'alert' : null);

/** F5 plan Ruling 2, one rule per kind. */
const RULES: Record<NotificationKind, Rule> = {
  'order.created': (u, _e, at) => alertIf(owner(u) || plantHeadHere(u, at)),
  'truck.assigned': (u, _e, at) =>
    u.role === 'supervisor' && at ? 'row-and-sync' : alertIf(plantHeadHere(u, at)),
  // TON-57 Ruling 21: the plant head runs the yard and is alerted; the office keeps a quiet row.
  'truck.arrived': (u, _e, at) => (plantHeadHere(u, at) ? 'alert' : owner(u) || u.role === 'city_staff' ? 'row' : null),
  // TON-57: saving the weights asks the approvers; approving (the dispatch) tells the office, the
  // plant head, and the plant's supervisors by a silent sync so their Done today updates.
  'truck.weighed': (u) => alertIf(can(u.role, 'dispatch.approve')),
  'truck.dispatched': (u, _e, at) =>
    u.role === 'supervisor' && at ? 'row-and-sync' : alertIf(owner(u) || u.role === 'city_staff' || plantHeadHere(u, at)),
  'order.over_tolerance': (u, e) => alertIf(owner(u) || creator(u, e)),
  'order.short_closed': (u, e, at) => alertIf(owner(u) || creator(u, e) || plantHeadHere(u, at)),
  'broker.payment_recorded': (u) => alertIf(can(u.role, 'money.view')),
  'rejection.created': (u) => alertIf(can(u.role, 'rejections.manage')),
  'orders.aged': (u) => alertIf(u.role === 'owner' || u.role === 'city_staff'),
};

/** Who is told about `e`, in `users` order: active people only, never the actor. */
export function recipientsFor(e: NotifyEvent, users: readonly RecipientUser[]): Recipient[] {
  const plants = new Set(e.plantIds);
  const out: Recipient[] = [];
  for (const u of users) {
    if (!u.active || u.id === e.actorId) continue;
    const delivery = RULES[e.kind](u, e, u.plantIds.some((p) => plants.has(p)));
    if (delivery) out.push({ userId: u.id, role: u.role, delivery });
  }
  return out;
}
