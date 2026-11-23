import type { Role, UnitBasis } from '@tonnage/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { AccessClaims, Tokens } from '../auth/tokens.ts';
import type { Tx } from '../db/client.ts';
import { tenants, userPlants, users } from '../db/schema/index.ts';

/** The signed-in person, loaded inside the request's transaction. */
export interface AuthedUser {
  id: string;
  tenantId: string;
  tenantName: string;
  role: Role;
  plantIds: string[];
  name: string;
  mobile: string;
  preferences: { unitBasis: UnitBasis };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** The claims of the request's bearer token, or null when there is none or it is not valid at `now`. */
export async function bearerClaims(
  tokens: Tokens,
  authorization: string | undefined,
  now: number,
): Promise<AccessClaims | null> {
  const token = BEARER.exec(authorization ?? '')?.[1];
  if (!token) return null;
  return tokens.verifyAccess(token, now);
}

/**
 * The token's user, or null when it is missing or inactive. Runs in the tenant's transaction (RLS);
 * no row lock, so reads never queue behind a write to the user.
 */
export async function loadAuthedUser(tx: Tx, claims: AccessClaims): Promise<AuthedUser | null> {
  const [row] = await tx
    .select({
      id: users.id,
      tenantId: users.tenantId,
      tenantName: tenants.name,
      role: users.role,
      active: users.active,
      name: users.name,
      mobile: users.mobile,
      preferences: users.preferences,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.id, claims.userId), eq(users.tenantId, claims.tenantId)));
  if (!row?.active) return null;
  const plants = await tx
    .select({ plantId: userPlants.plantId })
    .from(userPlants)
    .where(eq(userPlants.userId, row.id))
    .orderBy(asc(userPlants.plantId));
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName: row.tenantName,
    role: row.role,
    plantIds: plants.map((p) => p.plantId),
    name: row.name,
    mobile: row.mobile,
    preferences: { unitBasis: row.preferences.unitBasis },
  };
}
