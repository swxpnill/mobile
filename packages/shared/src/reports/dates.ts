import { istDateOf } from '../rules/numbering.ts';
import { REPORT_MAX_DAYS } from './facts.ts';

export const AGE_BUCKETS = ['0–5', '6–10', '11–20', '21+'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

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

/** Edges are floor(aged/2), aged and 2 x aged. */
export function ageBucket(days: number, agedOrderDays: number): AgeBucket {
  if (days <= Math.floor(agedOrderDays / 2)) return AGE_BUCKETS[0];
  if (days <= agedOrderDays) return AGE_BUCKETS[1];
  if (days <= 2 * agedOrderDays) return AGE_BUCKETS[2];
  return AGE_BUCKETS[3];
}

/** `YYYY-MM` of an IST date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}
