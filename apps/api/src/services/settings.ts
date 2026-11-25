import { tenantSettingsSchema, type TenantSettings } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { tenants } from '../db/schema/index.ts';
import { AppError } from '../http/errors.ts';

/**
 * The tenant's stored settings with defaults filled in; `forUpdate` locks the row for a
 * read-modify-write. The tenants table has no RLS, so the tenant is always named explicitly.
 */
export async function loadSettings(tx: Tx, tenantId: string, forUpdate = false): Promise<TenantSettings> {
  const query = tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const [row] = await (forUpdate ? query.for('update') : query);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return tenantSettingsSchema.parse(row.settings);
}
