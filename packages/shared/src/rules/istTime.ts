import { istDateParts } from './numbering.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IST_OFFSET_MS = (5 * 60 + 30) * MINUTE_MS;

/** Start of the IST calendar day containing `ms` (00:00 IST), as epoch ms. */
export function istDayStart(ms: number): number {
  const { year, month, day } = istDateParts(ms);
  return Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
}

/** Monday 00:00 IST of the IST week containing `ms`, as epoch ms. */
export function istWeekStart(ms: number): number {
  const dayStart = istDayStart(ms);
  const weekday = new Date(dayStart + IST_OFFSET_MS).getUTCDay(); // 0 = Sunday
  return dayStart - ((weekday + 6) % 7) * DAY_MS;
}
