import type { Me, User } from '@tonnage/shared';
import type { users } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';

type UserRow = typeof users.$inferSelect;

/** `inactive` if not active; else `invited` until the person first signs in; else `active`. */
export function userStatus(u: Pick<UserRow, 'active' | 'lastSeenAt'>): User['status'] {
  if (!u.active) return 'inactive';
  return u.lastSeenAt === null ? 'invited' : 'active';
}

/** A user row and its plant ids as `userSchema`. */
export function toUser(u: UserRow, plantIds: readonly string[]): User {
  return {
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    role: u.role,
    plantIds: [...plantIds],
    active: u.active,
    status: userStatus(u),
    version: u.version,
  };
}

/** The signed-in person as `meSchema`. */
export function toMe(u: AuthedUser): Me {
  return {
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    role: u.role,
    plantIds: [...u.plantIds],
    preferences: { unitBasis: u.preferences.unitBasis },
    tenant: { id: u.tenantId, name: u.tenantName },
  };
}
