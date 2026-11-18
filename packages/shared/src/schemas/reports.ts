import { z } from 'zod';
import { REPORT_KINDS } from '../reports/facts.ts';
import { idSchema } from './common.ts';
import { isoDateSchema } from './money.ts';

const int = z.number().int();
const str = z.string();
const strNull = z.string().nullable();

export const reportKindSchema = z.enum(REPORT_KINDS);

export const reportQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    companyId: idSchema.optional(),
    customerId: idSchema.optional(),
    brokerId: idSchema.optional(),
    plantId: idSchema.optional(),
    bucket: z.string().min(1).max(20).optional(),
  })
  .strict();
export type ReportQuery = z.infer<typeof reportQuerySchema>;

const head = <K extends (typeof REPORT_KINDS)[number]>(kind: K) => ({
  kind: z.literal(kind),
  from: isoDateSchema,
  to: isoDateSchema,
  truncated: z.boolean(),
});

const companyTotal = z.object({ companyId: idSchema, companyCode: str, companyName: str, netKg: int, trucks: int }).strict();
const companyValue = z
  .object({ companyId: idSchema, companyCode: str, companyName: str, netKg: int, valueRupees: int, trucks: int })
  .strict();

const dispatchRegisterSchema = z
  .object({
    ...head('dispatch-register'),
    rows: z.array(
      z
        .object({
          truckId: idSchema,
          date: isoDateSchema,
          companyCode: str,
          orderNumber: str,
          subOrderNumber: str,
          customerName: strNull,
          brokerName: strNull,
          vehicleNo: str,
          loadingSlipNo: str,
          productName: str,
          lengthValue: int.nullable(),
          lengthUnit: strNull,
          netKg: int,
          billedRate: int,
          valueRupees: int,
        })
        .strict(),
    ),
    summary: z
      .object({ netKg: int, trucks: int, overUnderKg: int, valueRupees: int, byCompany: z.array(companyTotal) })
      .strict(),
  })
  .strict();

const pendingOrdersSchema = z
  .object({
    ...head('pending-orders'),
    rows: z.array(
      z
        .object({
          subOrderId: idSchema,
          orderId: idSchema,
          subOrderNumber: str,
          companyCode: str,
          customerName: strNull,
          createdAt: str,
          ageDays: int,
          bucket: str,
          orderedKg: int,
          dispatchedKg: int,
          pendingKg: int,
        })
        .strict(),
    ),
    summary: z
      .object({
        pendingKg: int,
        subOrders: int,
        byBucket: z.array(z.object({ bucket: str, pendingKg: int, count: int }).strict()),
      })
      .strict(),
  })
  .strict();

const unitSalesSchema = z
  .object({
    ...head('unit-sales'),
    rows: z.array(
      z
        .object({
          companyId: idSchema,
          companyCode: str,
          companyName: str,
          productId: idSchema,
          productName: str,
          netKg: int,
          valueRupees: int,
          trucks: int,
        })
        .strict(),
    ),
    summary: z.object({ netKg: int, valueRupees: int, byCompany: z.array(companyValue) }).strict(),
  })
  .strict();

const brokerTotals = {
  netKg: int,
  commissionRupees: int,
  overpriceRupees: int,
  earnedRupees: int,
  paidRupees: int,
  dueRupees: int,
};
const brokerWiseSchema = z
  .object({
    ...head('broker-wise'),
    rows: z.array(z.object({ brokerId: idSchema, brokerName: str, ...brokerTotals }).strict()),
    summary: z.object(brokerTotals).strict(),
  })
  .strict();

const customerTotals = { bookedKg: int, bookedValueRupees: int, liftedKg: int, liftedValueRupees: int };
const customerWiseSchema = z
  .object({
    ...head('customer-wise'),
    rows: z.array(z.object({ customerId: idSchema.nullable(), customerName: strNull, ...customerTotals }).strict()),
    summary: z.object(customerTotals).strict(),
  })
  .strict();

const productWiseSchema = z
  .object({
    ...head('product-wise'),
    rows: z.array(
      z
        .object({
          productId: idSchema,
          productName: str,
          sizeLabel: str,
          lengthValue: int.nullable(),
          lengthUnit: strNull,
          netKg: int,
          trucks: int,
        })
        .strict(),
    ),
    summary: z.object({ netKg: int, trucks: int }).strict(),
  })
  .strict();

const loadingVarianceSchema = z
  .object({
    ...head('loading-variance'),
    rows: z.array(
      z
        .object({
          truckId: idSchema,
          date: isoDateSchema,
          plantName: str,
          vehicleNo: str,
          subOrderNumber: str,
          plannedKg: int,
          netKg: int,
          diffKg: int,
        })
        .strict(),
    ),
    summary: z.object({ trucks: int, overTrucks: int, underTrucks: int, overKg: int, underKg: int }).strict(),
  })
  .strict();

export const reportSchema = z.discriminatedUnion('kind', [
  dispatchRegisterSchema,
  pendingOrdersSchema,
  unitSalesSchema,
  brokerWiseSchema,
  customerWiseSchema,
  productWiseSchema,
  loadingVarianceSchema,
]);
