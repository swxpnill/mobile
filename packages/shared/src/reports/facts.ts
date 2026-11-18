import type { EarningLine } from '../rules/trucks.ts';
import type { LedgerRow } from '../rules/ledger.ts';
import type { AgeBucket } from './dates.ts';

export const REPORT_KINDS = [
  'dispatch-register',
  'pending-orders',
  'unit-sales',
  'broker-wise',
  'customer-wise',
  'product-wise',
  'loading-variance',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_ROW_CAP = 5_000;
export const REPORT_MAX_DAYS = 366;

/** One dispatched truck line. `plannedKg` is the truck's plan for that line. */
export interface TruckLineFact {
  truckId: string;
  /** Gross `capturedAt`: the instant that decides the IST day. */
  dispatchedAt: string;
  companyId: string;
  companyCode: string;
  companyName: string;
  plantId: string;
  plantName: string;
  orderId: string;
  orderNumber: string;
  subOrderNumber: string;
  customerId: string | null;
  customerName: string | null;
  brokerId: string | null;
  brokerName: string | null;
  vehicleNo: string;
  loadingSlipNo: string;
  productId: string;
  productName: string;
  sizeLabel: string;
  lengthValue: number | null;
  lengthUnit: string | null;
  plannedKg: number;
  netKg: number;
  ratePerMt: number;
  overpricePerMt: number;
}

/** A non-terminal sub-order. */
export interface OpenSubOrderFact {
  subOrderId: string;
  orderId: string;
  subOrderNumber: string;
  companyId: string;
  companyCode: string;
  customerId: string | null;
  customerName: string | null;
  createdAt: string;
  orderedKg: number;
  dispatchedKg: number;
  pendingKg: number;
}

/** A line of a non-draft order. */
export interface BookedLineFact {
  orderId: string;
  createdAt: string;
  companyId: string;
  customerId: string | null;
  customerName: string | null;
  orderedKg: number;
  valueRupees: number;
}

export interface BrokerFact {
  brokerId: string;
  brokerName: string;
  rows: (LedgerRow & { earningLines: EarningLine[] })[];
}

export interface ReportFacts {
  truckLines: TruckLineFact[];
  openSubOrders: OpenSubOrderFact[];
  bookedLines: BookedLineFact[];
  brokers: BrokerFact[];
}

export interface ReportFilter {
  from: string;
  to: string;
  today: string;
  agedOrderDays: number;
  companyId?: string;
  customerId?: string;
  brokerId?: string;
  plantId?: string;
  bucket?: AgeBucket;
}
