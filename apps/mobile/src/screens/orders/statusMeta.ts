import type { OrderStatus } from '@tonnage/shared';
import type { BadgeKind } from '../../ui';

/** Canvas status badges: label and colour for every derived order status. */
export const STATUS_META: Record<OrderStatus, { label: string; short: string; kind: BadgeKind }> = {
  open: { label: 'Open', short: 'Open', kind: 'br' },
  partly_dispatched: { label: 'Partly dispatched', short: 'Partial', kind: 'wn' },
  completed: { label: 'Completed', short: 'Completed', kind: 'ok' },
  short_closed: { label: 'Short closed', short: 'Short closed', kind: 'nu' },
  cancelled: { label: 'Cancelled', short: 'Cancelled', kind: 'dg' },
  draft: { label: 'Draft', short: 'Draft', kind: 'nu' },
};

export const statusMeta = (s: OrderStatus) => STATUS_META[s];
