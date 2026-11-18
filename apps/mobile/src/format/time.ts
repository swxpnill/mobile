import { istDateParts } from '@tonnage/shared';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const istHour = (ms: number) => new Date(ms + IST_OFFSET_MS).getUTCHours();
const istDayNumber = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / 86_400_000);

/** Good morning (before 12), afternoon (before 17), evening — by the clock in India. */
export function istGreeting(nowMs: number): string {
  const h = istHour(nowMs);
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** "Tuesday, 3 November" (IST). */
export function istLongDate(nowMs: number): string {
  const { month, day } = istDateParts(nowMs);
  const weekday = new Date(nowMs + IST_OFFSET_MS).getUTCDay();
  return `${DAYS[weekday]}, ${day} ${MONTHS[month - 1]}`;
}

/** "just now", "18 min ago", "2 h ago" (same IST day), "Yesterday", "31 Oct", "31 Oct 2025". */
export function relativeTime(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  const diff = Math.max(0, nowMs - ms);
  const days = istDayNumber(nowMs) - istDayNumber(ms);
  if (days <= 0) {
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    return `${Math.floor(diff / 3_600_000)} h ago`;
  }
  if (days === 1) return 'Yesterday';
  const d = istDateParts(ms);
  const label = `${d.day} ${MONTHS[d.month - 1]!.slice(0, 3)}`;
  return d.year === istDateParts(nowMs).year ? label : `${label} ${d.year}`;
}

/** "10:48" (IST, 24-hour). */
export function istClock(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "Tuesday 3 Nov" (IST). */
export function istShortDay(nowMs: number): string {
  const { month, day } = istDateParts(nowMs);
  const weekday = new Date(nowMs + IST_OFFSET_MS).getUTCDay();
  return `${DAYS[weekday]} ${day} ${MONTHS[month - 1]!.slice(0, 3)}`;
}

const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

function dateParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/** "14 Nov 2026" from an IST calendar date `YYYY-MM-DD`; `pad` gives "03 Nov 2026". */
export function dateLabel(iso: string, opts: { year?: boolean; pad?: boolean } = {}): string {
  const { y, m, d } = dateParts(iso);
  const day = opts.pad ? String(d).padStart(2, '0') : String(d);
  return `${day} ${SHORT_MONTHS[m - 1]}${opts.year === false ? '' : ` ${y}`}`;
}

/** "November 2026". */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

/** "November" for `YYYY-MM`. */
export function monthName(yyyyMm: string): string {
  return MONTHS[Number(yyyyMm.slice(5, 7)) - 1] ?? yyyyMm;
}

/** The calendar date `days` after `iso` (negative goes back). */
export function addDays(iso: string, days: number): string {
  const { y, m, d } = dateParts(iso);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Ledger day groups: "Today", "Yesterday", "3 Nov", or "3 Nov 2025" in another year. */
export function dayGroupLabel(iso: string, today: string): string {
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return dateLabel(iso, { year: iso.slice(0, 4) !== today.slice(0, 4) });
}
