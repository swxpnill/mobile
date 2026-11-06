import { z } from 'zod';
import { PRICING_METHODS } from '../settings.ts';
import {
  CLOSE_KINDS,
  SHORT_CLOSE_REASONS,
  SUB_ORDER_STATUSES,
} from '../rules/status.ts';
import { idSchema, versionSchema } from './common.ts';
import { commissionPerMtSchema, lengthSchema, ratePerMtSchema } from './masters.ts';

export const ORDER_TYPES = ['customer_broker', 'customer', 'broker_only'] as const;
export const orderTypeSchema = z.enum(ORDER_TYPES);
export type OrderType = z.infer<typeof orderTypeSchema>;

export const orderedKgSchema = z.number().int().min(1).max(10_000_000);

export const orderLineInputSchema = z.object({
  id: idSchema.optional(),
  productId: idSchema,
  length: lengthSchema,
  orderedKg: orderedKgSchema,
  /** Required for direct pricing; an override under basic + conversion. */
  typedRate: ratePerMtSchema.nullable(),
  overpricePerMt: ratePerMtSchema,
  version: versionSchema.optional(),
});
export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

export const subOrderInputSchema = z.object({
  id: idSchema.optional(),
  companyId: idSchema,
  lines: z.array(orderLineInputSchema).min(1).max(30),
  version: versionSchema.optional(),
});
export type SubOrderInput = z.infer<typeof subOrderInputSchema>;

const orderFields = {
  type: orderTypeSchema,
  customerId: idSchema.nullable(),
  brokerId: idSchema.nullable(),
  commissionPerMt: commissionPerMtSchema.nullable(),
  billToId: idSchema.nullable(),
  shipToId: idSchema.nullable(),
  pricingMethod: z.enum(PRICING_METHODS),
  basicRate: ratePerMtSchema.nullable(),
  subOrders: z.array(subOrderInputSchema).min(1).max(10),
  notify: z.object({ customer: z.boolean(), broker: z.boolean() }),
};

type OrderShape = {
  type: (typeof ORDER_TYPES)[number];
  customerId: string | null;
  brokerId: string | null;
  commissionPerMt: number | null;
  billToId: string | null;
  shipToId: string | null;
  pricingMethod: (typeof PRICING_METHODS)[number];
  basicRate: number | null;
  subOrders: { companyId: string; lines: { typedRate: number | null }[] }[];
};

/** Who must be on the order for its type, and what each pricing method needs (§8.3 flow 1). */
function orderRules(o: OrderShape, ctx: z.RefinementCtx): void {
  const need = (ok: boolean, path: string, message: string) => {
    if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
  };
  const hasCustomer = o.type !== 'broker_only';
  const hasBroker = o.type !== 'customer';
  if (hasCustomer) {
    need(o.customerId !== null, 'customerId', 'Choose the customer');
    need(o.billToId !== null, 'billToId', 'Choose the bill-to address');
    need(o.shipToId !== null, 'shipToId', 'Choose where to ship');
  }
  if (hasBroker) {
    need(o.brokerId !== null, 'brokerId', 'Choose the broker');
    need(o.commissionPerMt !== null, 'commissionPerMt', 'Enter the commission');
  } else {
    need(o.brokerId === null, 'brokerId', 'A customer order has no broker');
    need(o.commissionPerMt === null, 'commissionPerMt', 'A customer order has no commission');
  }
  if (o.pricingMethod === 'basic_conversion') {
    need(o.basicRate !== null, 'basicRate', 'Enter the basic rate');
  }
  const seen = new Set<string>();
  o.subOrders.forEach((s, si) => {
    if (seen.has(s.companyId)) {
      ctx.addIssue({ code: 'custom', path: ['subOrders', si, 'companyId'], message: 'This company is already on the order' });
    }
    seen.add(s.companyId);
    if (o.pricingMethod === 'direct') {
      s.lines.forEach((l, li) => {
        if (l.typedRate === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['subOrders', si, 'lines', li, 'typedRate'],
            message: 'Enter the rate',
          });
        }
      });
    }
  });
}

export const createOrderBodySchema = z
  .object({ draftId: idSchema.nullable(), ...orderFields })
  .superRefine(orderRules);
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

export const updateOrderBodySchema = z
  .object({ ...orderFields, version: versionSchema })
  .superRefine(orderRules);
export type UpdateOrderBody = z.infer<typeof updateOrderBodySchema>;

const DRAFT_MAX_CHARS = 64 * 1024;

export const draftBodySchema = z.object({
  payload: z
    .record(z.string(), z.unknown())
    .refine((p) => JSON.stringify(p).length <= DRAFT_MAX_CHARS, 'Draft is too large'),
  version: versionSchema.optional(),
});
export type DraftBody = z.infer<typeof draftBodySchema>;

export const draftSchema = z.object({
  id: idSchema,
  payload: z.record(z.string(), z.unknown()),
  version: versionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.object({ id: idSchema, name: z.string() }),
});
export type Draft = z.infer<typeof draftSchema>;

const qtyTotalsSchema = z.object({
  orderedKg: z.number().int(),
  dispatchedKg: z.number().int(),
  closedKg: z.number().int(),
  reservedKg: z.number().int(),
  pendingKg: z.number().int(),
  overKg: z.number().int(),
});
export type QtyTotalsDto = z.infer<typeof qtyTotalsSchema>;

export const subOrderStatusSchema = z.enum(SUB_ORDER_STATUSES);
export const orderStatusSchema = z.enum([...SUB_ORDER_STATUSES, 'draft']);

const money = z.number().int().optional();

export const orderLineSchema = z.object({
  id: idSchema,
  productId: idSchema,
  productName: z.string(),
  length: lengthSchema,
  orderedKg: z.number().int(),
  dispatchedKg: z.number().int(),
  closedKg: z.number().int(),
  reservedKg: z.number().int(),
  pendingKg: z.number().int(),
  overKg: z.number().int(),
  rate: money,
  rateEdited: z.boolean(),
  basicRateSnapshot: z.number().int().nullable().optional(),
  conversionSnapshot: money,
  overpricePerMt: money,
  lineValue: money,
  version: versionSchema,
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const truckStateSchema = z.enum(['assigned', 'at_gate', 'loading', 'dispatched', 'cancelled']);
export type TruckState = z.infer<typeof truckStateSchema>;

export const openTruckSchema = z.object({
  id: idSchema,
  vehicleNo: z.string(),
  state: truckStateSchema,
  tareKg: z.number().int().nullable(),
});
export type OpenTruck = z.infer<typeof openTruckSchema>;

export const subOrderSchema = z.object({
  id: idSchema,
  number: z.string(),
  suffix: z.string(),
  companyId: idSchema,
  companyCode: z.string(),
  companyName: z.string(),
  status: subOrderStatusSchema,
  closeKind: z.enum(CLOSE_KINDS).nullable(),
  closeReason: z.string().nullable(),
  closeNote: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: z.object({ id: idSchema, name: z.string() }).nullable(),
  lines: z.array(orderLineSchema),
  totals: qtyTotalsSchema,
  openTrucks: z.array(openTruckSchema),
  dispatchedTrucks: z.number().int(),
  value: money,
  version: versionSchema,
});
export type SubOrder = z.infer<typeof subOrderSchema>;

const partyRefSchema = z.object({ id: idSchema, name: z.string(), city: z.string() });
const addressRefSchema = z.object({ id: idSchema, label: z.string(), address: z.string() });

export const brokerEarningEstimateSchema = z.object({
  commission: z.number().int(),
  overprice: z.number().int(),
  total: z.number().int(),
  commissionKg: z.number().int(),
  overpriceKg: z.number().int(),
});

export const orderSchema = z.object({
  id: idSchema,
  number: z.string(),
  status: orderStatusSchema,
  type: orderTypeSchema,
  customer: partyRefSchema.nullable(),
  broker: partyRefSchema.nullable(),
  commissionPerMtSnapshot: z.number().int().nullable().optional(),
  billTo: addressRefSchema.nullable(),
  shipTo: addressRefSchema.nullable(),
  pricingMethod: z.enum(PRICING_METHODS),
  basicRate: z.number().int().nullable().optional(),
  notify: z.object({ customer: z.boolean(), broker: z.boolean() }),
  subOrders: z.array(subOrderSchema),
  totals: qtyTotalsSchema,
  estimatedValue: money,
  brokerEarningEstimate: brokerEarningEstimateSchema.optional(),
  ageDays: z.number().int(),
  isAged: z.boolean(),
  createdAt: z.string(),
  createdBy: z.object({ id: idSchema, name: z.string() }),
  version: versionSchema,
  /** Present on edit responses: non-blocking notes such as "below what is planned on trucks". */
  warnings: z.array(z.object({ lineId: idSchema, code: z.literal('BELOW_RESERVED') })).optional(),
});
export type Order = z.infer<typeof orderSchema>;

export const orderSummarySchema = z.object({
  id: idSchema,
  number: z.string(),
  status: orderStatusSchema,
  type: orderTypeSchema,
  customerName: z.string().nullable(),
  customerCity: z.string().nullable(),
  brokerName: z.string().nullable(),
  companyCodes: z.array(z.string()),
  productsLabel: z.string(),
  totals: qtyTotalsSchema,
  estimatedValue: money,
  createdAt: z.string(),
  ageDays: z.number().int(),
  isAged: z.boolean(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const ORDER_LIST_STATUSES = ['all', ...SUB_ORDER_STATUSES] as const;
export type OrderListStatus = (typeof ORDER_LIST_STATUSES)[number];

export const orderListQuerySchema = z.object({
  status: z.enum(ORDER_LIST_STATUSES).default('all'),
  companyId: idSchema.optional(),
  q: z.string().trim().max(60).optional(),
  aged: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderListSchema = z.object({
  items: z.array(orderSummarySchema),
  counts: z.record(z.enum(ORDER_LIST_STATUSES), z.number().int()),
  nextCursor: z.string().nullable(),
});
export type OrderList = z.infer<typeof orderListSchema>;

export const homeQuerySchema = z.object({ companyId: idSchema.optional() });

export const homeSchema = z.object({
  pendingKg: z.number().int(),
  openOrders: z.number().int(),
  unitCount: z.number().int(),
  perCompany: z.array(
    z.object({ companyId: idSchema, code: z.string(), name: z.string(), pendingKg: z.number().int() }),
  ),
  agedOrders: z.number().int(),
  agedOrderDays: z.number().int(),
  bookedToday: z.object({ kg: z.number().int(), orders: z.number().int(), value: money }),
  dispatchedToday: z.object({ kg: z.number().int(), trucks: z.number().int() }),
  sentThisWeek: z.object({ kg: z.number().int(), changePct: z.number().int().nullable() }),
});
export type Home = z.infer<typeof homeSchema>;

export const shortCloseBodySchema = z.object({
  reason: z.enum(SHORT_CLOSE_REASONS),
  note: z.string().trim().max(200),
  cancelOpenTrucks: z.boolean(),
  version: versionSchema,
});
export type ShortCloseBody = z.infer<typeof shortCloseBodySchema>;

export const openTrucksDetailsSchema = z.object({ trucks: z.array(openTruckSchema) });

export const reopenBodySchema = z.object({ version: versionSchema });

export const moveQuantityBodySchema = z.object({
  fromLineId: idSchema,
  toCompanyId: idSchema,
  kg: orderedKgSchema,
  version: versionSchema,
});
export type MoveQuantityBody = z.infer<typeof moveQuantityBodySchema>;

export const deleteOrderBodySchema = z.object({ confirmNumber: z.string().trim().min(1).max(40) });

export const deletePreviewSchema = z.object({
  subOrders: z.number().int(),
  lines: z.number().int(),
  trucks: z.number().int(),
  dispatchedKg: z.number().int(),
  weighments: z.number().int(),
});
export type DeletePreview = z.infer<typeof deletePreviewSchema>;

export const activityEntrySchema = z.object({
  id: idSchema,
  action: z.string(),
  actorName: z.string(),
  at: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
