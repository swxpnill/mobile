import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../db/client.ts';
import { activityLog } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';

export interface ActivityEntry {
  entityType: string;
  entityId: string;
  action: string;
  meta?: Record<string, unknown>;
  orderId?: string;
}

/** Appends one activity row in the request's transaction, so it commits or rolls back with the change. */
export async function logActivity(tx: Tx, a: AuthedUser, now: number, e: ActivityEntry): Promise<void> {
  const at = new Date(now);
  await tx.insert(activityLog).values({
    id: uuidv7(),
    tenantId: a.tenantId,
    entityType: e.entityType,
    entityId: e.entityId,
    orderId: e.orderId ?? null,
    action: e.action,
    actorId: a.id,
    meta: e.meta ?? {},
    at,
    createdAt: at,
    updatedAt: at,
  });
}
