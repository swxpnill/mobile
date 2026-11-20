import { z } from 'zod';
import { PAYMENT_MODES } from '../rules/ledger.ts';
import { idSchema } from '../schemas/common.ts';
import { syncRejectCodeSchema } from '../schemas/trucks.ts';

/**
 * What a notification is about (F5 plan Ruling 2). Payloads hold facts only — integer kg and
 * rupees, names — and are rendered on the phone in the viewer's unit basis (spec §5.6).
 */
export const NOTIFICATION_KINDS = [
  'order.created',
  'truck.assigned',
  'truck.dispatched',
  'truck.weighed',
  'order.over_tolerance',
  'order.short_closed',
  'broker.payment_recorded',
  'rejection.created',
  'orders.aged',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const kg = z.number().int().min(0);
const rupees = z.number().int();
const name = z.string().min(1).max(200);

const DATA = {
  'order.created': z.strictObject({
    orderId: idSchema,
    orderNumber: name,
    actorName: name,
    partyName: name,
    orderedKg: kg,
    companyCodes: z.array(z.string().min(1).max(10)).min(1),
  }),
  'truck.assigned': z.strictObject({
    truckId: idSchema,
    orderId: idSchema,
    vehicleNo: name,
    plannedKg: kg,
    partyName: name,
    plantName: name,
  }),
  'truck.dispatched': z.strictObject({
    truckId: idSchema,
    orderId: idSchema,
    vehicleNo: name,
    netKg: kg,
    partyName: name,
    companyName: name,
  }),
  // TON-57: weights saved at the plant; the office approves the dispatch.
  'truck.weighed': z.strictObject({
    truckId: idSchema,
    orderId: idSchema,
    vehicleNo: name,
    netKg: kg,
    partyName: name,
    plantName: name,
  }),
  'order.over_tolerance': z.strictObject({
    orderId: idSchema,
    subOrderId: idSchema,
    subOrderNumber: name,
    partyName: name,
    overKg: kg,
  }),
  'order.short_closed': z.strictObject({
    orderId: idSchema,
    subOrderNumber: name,
    partyName: name,
    closedKg: kg,
  }),
  'broker.payment_recorded': z.strictObject({
    brokerId: idSchema,
    brokerName: name,
    paidRupees: rupees.min(1),
    dueRupees: rupees,
    mode: z.enum(PAYMENT_MODES),
    actorName: name,
  }),
  'rejection.created': z.strictObject({
    rejectionId: idSchema,
    vehicleNo: name,
    code: syncRejectCodeSchema,
  }),
  'orders.aged': z.strictObject({
    count: z.number().int().min(1),
    days: z.number().int().min(1),
    pendingKg: kg,
  }),
} satisfies Record<NotificationKind, z.ZodType>;

type DataOf = { [K in NotificationKind]: z.infer<(typeof DATA)[K]> };
/** A notification's kind and payload, the part that `notify` builds and `renderNotification` reads. */
export type NotificationContent = { [K in NotificationKind]: { kind: K; data: DataOf[K] } }[NotificationKind];
export type NotificationData<K extends NotificationKind = NotificationKind> = DataOf[K];

const row = <K extends NotificationKind>(kind: K) =>
  z.strictObject({
    id: idSchema,
    kind: z.literal(kind),
    data: DATA[kind],
    deepLink: z.string().max(200),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  });

export const notificationSchema = z.discriminatedUnion('kind', [
  row('order.created'),
  row('truck.assigned'),
  row('truck.dispatched'),
  row('truck.weighed'),
  row('order.over_tolerance'),
  row('order.short_closed'),
  row('broker.payment_recorded'),
  row('rejection.created'),
  row('orders.aged'),
]);
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.strictObject({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const notificationListQuerySchema = z.object({ cursor: z.string().max(200).optional() });
export const unreadCountSchema = z.strictObject({ count: z.number().int().min(0) });

export const pushTokenBodySchema = z.strictObject({
  deviceId: z.string().min(8).max(64),
  token: z.string().min(1).max(200),
});
export type PushTokenBody = z.infer<typeof pushTokenBodySchema>;

/** What the push server hands one device: something to show, or a silent "sync now". */
export const pushMessageSchema = z.strictObject({
  token: z.string().min(1).max(200),
  message: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('alert'), notification: notificationSchema }),
    z.strictObject({ type: z.literal('sync'), reason: z.literal('tasks') }),
  ]),
});
export type PushMessage = z.infer<typeof pushMessageSchema>;
