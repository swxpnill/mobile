import { and, eq, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../db/client.ts';
import { drafts } from '../db/schema/index.ts';
import type { AuthedUser } from '../http/auth-hook.ts';
import type { DraftRow } from '../views/drafts.ts';

/** A draft belongs to its creator; the owner may open anyone's (row-level security keeps the tenant). */
export function visibleDraft(user: AuthedUser): SQL | undefined {
  return user.role === 'owner' ? undefined : eq(drafts.createdBy, user.id);
}

/** Saves a new draft (version 1) for the caller. The payload is stored as given (jsonb). */
export async function createDraft(
  tx: Tx,
  user: AuthedUser,
  payload: Record<string, unknown>,
  now: number,
): Promise<DraftRow> {
  const at = new Date(now);
  const [row] = await tx
    .insert(drafts)
    .values({ id: uuidv7(), tenantId: user.tenantId, createdBy: user.id, payload, createdAt: at, updatedAt: at })
    .returning();
  if (!row) throw new Error('draft insert returned no row');
  return row;
}

/** Booking from a draft consumes it; a draft already purged or someone else's is left alone (as the mock). */
export async function deleteDraftIfVisible(tx: Tx, user: AuthedUser, id: string): Promise<void> {
  await tx.delete(drafts).where(and(eq(drafts.id, id), visibleDraft(user)));
}

