import { istDateOf } from '../rules/numbering.ts';
import { REPORT_MAX_DAYS } from './facts.ts';

/** A bucket label such as `6–10`; the edges move with the `agedOrderDays` setting. */
export type AgeBucket = string;

/** IST `YYYY-MM-DD` of an instant. */
export function istDate(at: string | number): string {
  return istDateOf(at);
}

export function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function checkRange(from: string, to: string, today: string): 'ok' | 'ORDER' | 'TOO_LONG' | 'FUTURE' {
  if (to < from) return 'ORDER';
  if (to > today) return 'FUTURE';
  if (dayNumber(to) - dayNumber(from) + 1 > REPORT_MAX_DAYS) return 'TOO_LONG';
  return 'ok';
}

/** Whole IST days since the order was created. */
export function ageDays(createdAt: string, today: string): number {
  return Math.max(0, dayNumber(today) - dayNumber(istDate(createdAt)));
}

/** Labels for edges floor(aged/2), aged and 2 x aged: 10 gives 0–5, 6–10, 11–20, 21+. */
export function ageBucketLabels(agedOrderDays: number): AgeBucket[] {
  const h = Math.floor(agedOrderDays / 2);
  return [`0–${h}`, `${h + 1}–${agedOrderDays}`, `${agedOrderDays + 1}–${2 * agedOrderDays}`, `${2 * agedOrderDays + 1}+`];
}

export function ageBucket(days: number, agedOrderDays: number): AgeBucket {
  const labels = ageBucketLabels(agedOrderDays);
  if (days <= Math.floor(agedOrderDays / 2)) return labels[0]!;
  if (days <= agedOrderDays) return labels[1]!;
  if (days <= 2 * agedOrderDays) return labels[2]!;
  return labels[3]!;
}

/** `YYYY-MM` of an IST date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}
