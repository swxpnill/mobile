import { categoryTag, productDisplayName, type Product } from '@tonnage/shared';
import type { products } from '../db/schema/index.ts';

export type ProductRow = typeof products.$inferSelect;

/** A product with the companies that sell it, in the order they were sent (`position`). */
export type ProductGraph = ProductRow & { companyIds: string[] };

/** The graph as `productSchema` (no tenant id, creator or timestamps; name and tag derived, never stored). */
export function toProduct(p: ProductGraph): Product {
  return {
    id: p.id,
    category: p.category,
    grade: p.grade,
    sizeLabel: p.sizeLabel,
    displayName: productDisplayName(p),
    tag: categoryTag(p.category),
    conversionPerMt: p.conversionPerMt,
    standardLengths: p.standardLengths.map((l) => ({ ...l })),
    companyIds: [...p.companyIds],
    active: p.active,
    version: p.version,
  };
}
