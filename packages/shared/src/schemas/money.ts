import { z } from 'zod';
import { PAYMENT_MODES, UTR_REQUIRED } from '../rules/ledger.ts';
import { idSchema } from './common.ts';

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const refSchema = z.object({ id: idSchema, name: z.string() }).strict();
const rupeesSchema = z.number().int();
const kgSchema = z.number().int();

export const paymentModeSchema = z.enum(PAYMENT_MODES);

export const earningLineSchema = z
  .object({ productName: z.string(), netKg: kgSchema, commissionPerMt: rupeesSchema, overpricePerMt: rupeesSchema })
  .strict();
export type EarningLineView = z.infer<typeof earningLineSchema>;

export const ledgerEntrySchema = z
  .object({
    id: idSchema,
    kind: z.enum(['earning', 'payment', 'reversal']),
    /** Signed in the broker's favour: an earning +, a payment -(paid + TDS), a reversal the negation. */
    amountRupees: rupeesSchema,
    /** IST date the row counts on. */
    entryDate: isoDateSchema,
    createdAt: z.string(),
    createdBy: refSchema,
    truck: z
      .object({
        truckId: idSchema,
        vehicleNo: z.string(),
        orderId: idSchema,
        orderNumber: z.string(),
        subOrderNumber: z.string(),
        netKg: kgSchema,
      })
      .strict()
      .nullable(),
    earningLines: z.array(earningLineSchema),
    payment: z
      .object({
        mode: paymentModeSchema,
        utr: z.string().nullable(),
        paidRupees: rupeesSchema,
        tdsRupees: rupeesSchema,
        paidOn: isoDateSchema,
      })
      .strict()
      .nullable(),
    reversesId: idSchema.nullable(),
    reversedById: idSchema.nullable(),
    note: z.string().nullable(),
  })
  .strict();
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const ledgerBrokerSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    city: z.string(),
    defaultCommissionPerMt: z.number().int().nullable(),
    active: z.boolean(),
  })
  .strict();
export type LedgerBroker = z.infer<typeof ledgerBrokerSchema>;

export const ledgerQuerySchema = z
  .object({
    view: z.enum(['all', 'earnings', 'payments']).default('all'),
    before: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const brokerLedgerSchema = z
  .object({
    broker: ledgerBrokerSchema,
    summary: z
      .object({
        dueRupees: rupeesSchema,
        unpaidKg: kgSchema,
        month: z.string().regex(/^\d{4}-\d{2}$/),
        earnedThisMonthRupees: rupeesSchema,
        paidThisMonthRupees: rupeesSchema,
      })
      .strict(),
    items: z.array(ledgerEntrySchema),
    nextBefore: z.string().nullable(),
  })
  .strict();
export type BrokerLedger = z.infer<typeof brokerLedgerSchema>;

export const brokerDuesSchema = z
  .object({
    totalDueRupees: rupeesSchema,
    items: z.array(
      z
        .object({
          brokerId: idSchema,
          name: z.string(),
          city: z.string(),
          active: z.boolean(),
          dueRupees: rupeesSchema,
          lastEntryAt: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type BrokerDues = z.infer<typeof brokerDuesSchema>;

const utrSchema = z.string().min(4).max(30).regex(/^[A-Za-z0-9]+$/);

export const recordPaymentBodySchema = z
  .object({
    paidRupees: z.number().int().min(1).max(100_000_000),
    tdsRupees: z.number().int().min(0).default(0),
    mode: paymentModeSchema,
    utr: z.string().nullable(),
    paidOn: isoDateSchema,
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.tdsRupees > b.paidRupees) {
      ctx.addIssue({ code: 'custom', path: ['tdsRupees'], message: 'TDS cannot be more than the payment' });
    }
    const utr = b.utr === null ? '' : b.utr.trim();
    if (utr === '' && UTR_REQUIRED.has(b.mode)) {
      ctx.addIssue({ code: 'custom', path: ['utr'], message: 'Enter the UTR' });
    } else if (utr !== '' && !utrSchema.safeParse(utr).success) {
      ctx.addIssue({ code: 'custom', path: ['utr'], message: 'UTR is 4 to 30 letters or digits' });
    }
  })
  .transform((b) => ({ ...b, utr: b.utr === null || b.utr.trim() === '' ? null : b.utr.trim() }));
export type RecordPaymentBody = z.infer<typeof recordPaymentBodySchema>;

export const paymentResultSchema = z.object({ entry: ledgerEntrySchema, dueRupees: rupeesSchema }).strict();
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export const reverseEntryBodySchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
export type ReverseEntryBody = z.infer<typeof reverseEntryBodySchema>;

/** An IST date range; the handler applies `checkRange` (it needs today). */
export const brokerStatementQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema }).strict();
export type BrokerStatementQuery = z.infer<typeof brokerStatementQuerySchema>;

export const brokerStatementSchema = z
  .object({
    broker: ledgerBrokerSchema,
    from: isoDateSchema,
    to: isoDateSchema,
    openingDueRupees: rupeesSchema,
    earnedRupees: rupeesSchema,
    paidRupees: rupeesSchema,
    tdsRupees: rupeesSchema,
    closingDueRupees: rupeesSchema,
    items: z.array(ledgerEntrySchema),
  })
  .strict();
export type BrokerStatement = z.infer<typeof brokerStatementSchema>;
