export const LENGTH_UNITS = ['m', 'ft', 'mm'] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];
export interface Length {
  value: number;
  unit: LengthUnit;
}

/** "TMT Fe500D · 12 mm", "MS Billet · 100 × 100": category and grade, then the size. */
export function productDisplayName(p: { category: string; grade: string; sizeLabel: string }): string {
  const head = [p.category.trim(), p.grade.trim()].filter(Boolean).join(' ');
  return `${head} · ${p.sizeLabel.trim()}`;
}

/** Short badge for lists: first three letters of the category's last word ("MS Billet" → "BIL"). */
export function categoryTag(category: string): string {
  const words = category.trim().split(/\s+/);
  return (words[words.length - 1] ?? '').slice(0, 3).toUpperCase();
}

export function formatLength(l: Length): string {
  return `${l.value} ${l.unit}`;
}
