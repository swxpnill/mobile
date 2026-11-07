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
