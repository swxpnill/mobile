const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since booking, by elapsed time (the aged badge counts full days). */
export function orderAgeDays(createdAtMs: number, now: number): number {
  return Math.max(0, Math.floor((now - createdAtMs) / DAY_MS));
}

/**
 * An order is aged when `ageDays > agedOrderDays`, i.e. booked at or before this instant: the
 * cut-off for a SQL pre-filter (`created_at <= cutoff`).
 */
export function agedCutoff(now: number, agedOrderDays: number): number {
  return now - (agedOrderDays + 1) * DAY_MS;
}

const MM_SIZE = /^\d+(\.\d+)?\s*mm$/;
const labelCollator = new Intl.Collator('en', { numeric: true });

/** "TMT 12, 16 mm", "MS Billet", "TMT 16 mm · Angle": sizes in mm are merged per category. */
export function productsLabel(products: readonly { category: string; sizeLabel: string }[]): string {
  const byCategory = new Map<string, string[]>();
  for (const p of products) {
    const sizes = byCategory.get(p.category) ?? [];
    if (!sizes.includes(p.sizeLabel)) sizes.push(p.sizeLabel);
    byCategory.set(p.category, sizes);
  }
  return [...byCategory.entries()]
    .map(([category, sizes]) => {
      if (sizes.every((s) => MM_SIZE.test(s))) {
        const nums = sizes.map((s) => s.replace(/\s*mm$/, '')).sort(labelCollator.compare);
        return `${category} ${nums.join(', ')} mm`;
      }
      return category;
    })
    .join(' · ');
}
