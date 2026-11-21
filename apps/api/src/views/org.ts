import type { Company, Plant } from '@tonnage/shared';
import type { companies, plants } from '../db/schema/index.ts';

/** A company row as `companySchema` (no tenant id, no timestamps). */
export function toCompany(c: typeof companies.$inferSelect): Company {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    gstin: c.gstin,
    orderPrefix: c.orderPrefix,
    active: c.active,
    version: c.version,
  };
}

/** A plant row as `plantSchema`. */
export function toPlant(p: typeof plants.$inferSelect): Plant {
  return {
    id: p.id,
    companyId: p.companyId,
    name: p.name,
    location: p.location,
    active: p.active,
    version: p.version,
  };
}
