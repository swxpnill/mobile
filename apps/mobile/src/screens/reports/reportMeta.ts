import type { ReportKind } from '@tonnage/shared';
import type { IconName, Tone } from '../../ui';

/** The one extra filter a report takes besides range and unit (its own chip on board 23). */
export type ReportFilterKey = 'customer' | 'broker' | 'plant' | 'bucket';

export interface ReportMeta {
  title: string;
  caption: string;
  icon: IconName;
  tone: Tone;
  emptyText: string;
  /** The kind's own filter chip, if it has one. */
  filter: ReportFilterKey | null;
  /** The server filters this kind by company (the unit chip applies). */
  byCompany: boolean;
  /** False for pending orders, which is "as of now" and ignores the range. */
  ranged: boolean;
}

/** Board 23 tiles, plus "Over / under loading" (Ruling 9). Order is the tile order. */
export const REPORT_META: Record<ReportKind, ReportMeta> = {
  'dispatch-register': {
    title: 'Dispatch register',
    caption: 'Every truck, net weight',
    icon: 'truck',
    tone: 'gr',
    emptyText: 'No trucks dispatched in this period',
    filter: 'customer',
    byCompany: true,
    ranged: true,
  },
  'pending-orders': {
    title: 'Pending orders',
    caption: 'Ageing by days',
    icon: 'clock',
    tone: 'am',
    emptyText: 'No pending orders',
    filter: 'bucket',
    byCompany: true,
    ranged: false,
  },
  'unit-sales': {
    title: 'Unit-wise sales',
    caption: 'MT and ₹ per company',
    icon: 'factory',
    tone: 'bl',
    emptyText: 'No sales in this period',
    filter: null,
    byCompany: true,
    ranged: true,
  },
  'broker-wise': {
    title: 'Broker-wise',
    caption: 'Earned, paid, due',
    icon: 'wallet',
    tone: 'vi',
    emptyText: 'No broker earnings or payments in this period',
    filter: 'broker',
    byCompany: false,
    ranged: true,
  },
  'customer-wise': {
    title: 'Customer-wise',
    caption: 'Booked vs lifted',
    icon: 'user',
    tone: 'te',
    emptyText: 'No bookings or lifting in this period',
    filter: 'customer',
    byCompany: true,
    ranged: true,
  },
  'product-wise': {
    title: 'Product-wise',
    caption: 'Size and length mix',
    icon: 'box',
    tone: 'bl',
    emptyText: 'No products dispatched in this period',
    filter: null,
    byCompany: true,
    ranged: true,
  },
  'loading-variance': {
    title: 'Over / under loading',
    caption: 'Planned vs net per truck',
    icon: 'scales',
    tone: 'rd',
    emptyText: 'No trucks dispatched in this period',
    filter: 'plant',
    byCompany: false,
    ranged: true,
  },
};

/** The filter chip's label when nothing is picked. */
export const FILTER_ALL: Record<ReportFilterKey, string> = {
  customer: 'All customers',
  broker: 'All brokers',
  plant: 'All plants',
  bucket: 'All ages',
};

/** The query parameter each filter sets. */
export const FILTER_PARAM: Record<ReportFilterKey, 'customerId' | 'brokerId' | 'plantId' | 'bucket'> = {
  customer: 'customerId',
  broker: 'brokerId',
  plant: 'plantId',
  bucket: 'bucket',
};
