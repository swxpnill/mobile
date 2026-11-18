import { checkRange } from '@tonnage/shared';
import { addDays, dateLabel } from '../../format/time';

/** An inclusive range of IST calendar dates (`YYYY-MM-DD`). */
export interface DateRange {
  from: string;
  to: string;
}

export type PresetKey = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'thisFy';

/** Ruling 9: the range presets, in the order the sheet lists them (Custom follows). */
export const PRESETS: readonly { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'thisFy', label: 'This financial year' },
];

/** The range a preset stands for on `today` (IST). The financial year starts on 1 April. */
export function presetRange(key: PresetKey, today: string): DateRange {
  const month = today.slice(0, 7);
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case 'thisMonth':
      return { from: `${month}-01`, to: today };
    case 'lastMonth': {
      const end = addDays(`${month}-01`, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case 'thisFy': {
      const y = Number(today.slice(0, 4));
      const start = Number(today.slice(5, 7)) >= 4 ? y : y - 1;
      return { from: `${start}-04-01`, to: today };
    }
  }
}

/** The preset a range matches on `today`, if any. */
export function presetOf(r: DateRange, today: string): PresetKey | null {
  return PRESETS.find((p) => {
    const q = presetRange(p.key, today);
    return q.from === r.from && q.to === r.to;
  })?.key ?? null;
}

/**
 * "1 – 17 Nov 2026", "28 Oct – 17 Nov 2026", "1 Dec 2025 – 17 Jan 2026" or "17 Nov 2026".
 * `year: false` drops a shared year ("1 – 17 Nov", the preview card's caption).
 */
export function rangeLabel(from: string, to: string, opts: { year?: boolean } = {}): string {
  const year = opts.year !== false;
  if (from === to) return dateLabel(to, { year });
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${dateLabel(from)} – ${dateLabel(to)}`;
  const end = dateLabel(to, { year });
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))} – ${end}`;
  return `${dateLabel(from, { year: false })} – ${end}`;
}

/** Why a range cannot be used (the server's 422 rules, checked first), or null. */
export function rangeProblem(r: DateRange, today: string): string | null {
  switch (checkRange(r.from, r.to, today)) {
    case 'ORDER':
      return 'Pick an end date on or after the start';
    case 'TOO_LONG':
      return 'Pick at most 366 days';
    case 'FUTURE':
      return "The end date can't be after today";
    case 'ok':
      return null;
  }
}
