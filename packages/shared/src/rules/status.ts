import { totalsOf, type LineQty } from './quantities.ts';

export const CLOSE_KINDS = ['short_close', 'cancel', 'tolerance'] as const;
export type CloseKind = (typeof CLOSE_KINDS)[number];

export const SHORT_CLOSE_REASONS = [
  'Customer stopped lifting',
  'Rate changed',
  'Stock not available',
  'Other',
] as const;
export type ShortCloseReason = (typeof SHORT_CLOSE_REASONS)[number];

export const SUB_ORDER_STATUSES = [
  'open',
  'partly_dispatched',
  'completed',
  'short_closed',
  'cancelled',
] as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUSES)[number];
export type OrderStatus = SubOrderStatus | 'draft';

const TERMINAL: ReadonlySet<SubOrderStatus> = new Set(['completed', 'short_closed', 'cancelled']);

export function isTerminal(s: SubOrderStatus): boolean {
  return TERMINAL.has(s);
}

/** Derived, never stored (§5.3). First matching row wins. */
export function subOrderStatus(s: {
  closeKind: CloseKind | null;
  lines: readonly LineQty[];
}): SubOrderStatus {
  if (s.closeKind === 'cancel') return 'cancelled';
  if (s.closeKind === 'short_close') return 'short_closed';
  const t = totalsOf(s.lines);
  if (s.closeKind === 'tolerance' || (t.pendingKg === 0 && t.dispatchedKg > 0)) return 'completed';
  if (t.dispatchedKg > 0) return 'partly_dispatched';
  return 'open';
}

/**
 * Parent order status from its sub-orders' statuses (§5.3). "Any dispatched" is read from the
 * statuses: partly dispatched, completed and short closed all imply dispatches (a short close
 * with nothing dispatched is recorded as a cancel).
 */
export function orderStatus(o: {
  isDraft: boolean;
  subOrders: readonly SubOrderStatus[];
}): OrderStatus {
  if (o.isDraft) return 'draft';
  const subs = o.subOrders;
  if (subs.length === 0) return 'open';
  if (subs.every((s) => s === 'cancelled')) return 'cancelled';
  if (subs.every(isTerminal)) {
    return subs.includes('short_closed') ? 'short_closed' : 'completed';
  }
  if (subs.some((s) => s !== 'open' && s !== 'cancelled')) return 'partly_dispatched';
  return 'open';
}
