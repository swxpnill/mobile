import { z } from 'zod';
import { TRUCK_CANCEL_REASONS } from '../rules/trucks.ts';
import { idSchema, versionSchema } from './common.ts';
import { lengthSchema, phoneInputSchema } from './masters.ts';
import { orderedKgSchema, truckStateSchema } from './orders.ts';

/** One weighbridge reading, at most 100 t. */
/** The heaviest weighbridge reading the app takes, in kg (100 MT). */
export const MAX_READING_KG = 100_000;
export const weightKgSchema = z.number().int().min(1).max(MAX_READING_KG);
export type WeightKg = z.infer<typeof weightKgSchema>;
export const planKgSchema = orderedKgSchema;

export const vehicleNoSchema = z
  .string()
  .transform((v) => v.trim().toUpperCase().replace(/\s+/g, ' '))
  .pipe(z.string().min(4).max(15).regex(/^[A-Z0-9 ]+$/));
export type VehicleNo = z.infer<typeof vehicleNoSchema>;

export const driverPhoneSchema = phoneInputSchema;

export const loadPlanRowSchema = z.object({ orderLineId: idSchema, plannedKg: planKgSchema }).strict();
export type LoadPlanRow = z.infer<typeof loadPlanRowSchema>;

const planSchema = z
  .array(loadPlanRowSchema)
  .min(1)
  .max(20)
  .refine((rows) => new Set(rows.map((r) => r.orderLineId)).size === rows.length, {
    message: 'Each order line can appear once',
  });

const driverNameSchema = z.string().trim().min(1).max(60);
const lrNoSchema = z.string().trim().max(30).nullable();

export const assignTruckBodySchema = z
  .object({
    plantId: idSchema.optional(),
    vehicleNo: vehicleNoSchema,
    transporterId: idSchema.nullable(),
    driverName: driverNameSchema,
    driverPhone: driverPhoneSchema,
    lrNo: lrNoSchema,
    plan: planSchema,
  })
  .strict();
export type AssignTruckBody = z.infer<typeof assignTruckBodySchema>;

/** `plan` only while the truck is assigned, at the gate or loading; the server enforces TRUCK_LOCKED. */
export const editTruckBodySchema = z
  .object({
    vehicleNo: vehicleNoSchema.optional(),
    transporterId: idSchema.nullable().optional(),
    driverName: driverNameSchema.optional(),
    driverPhone: driverPhoneSchema.optional(),
    lrNo: lrNoSchema.optional(),
    plan: planSchema.optional(),
    version: versionSchema,
  })
  .strict();
export type EditTruckBody = z.infer<typeof editTruckBodySchema>;

export const cancelTruckBodySchema = z
  .object({ reason: z.enum(TRUCK_CANCEL_REASONS), note: z.string().max(200), version: versionSchema })
  .strict();
export type CancelTruckBody = z.infer<typeof cancelTruckBodySchema>;

const refSchema = z.object({ id: idSchema, name: z.string() });
const allocationSchema = z.object({ orderLineId: idSchema, netKg: z.number().int() });
const allocationsInputSchema = z
  .array(z.object({ orderLineId: idSchema, netKg: z.number().int().min(0) }))
  .min(1)
  .max(20);

export const weighmentSchema = z.object({
  id: idSchema,
  kind: z.enum(['tare', 'gross']),
  kg: z.number().int(),
  by: refSchema,
  capturedAt: z.string(),
  superseded: z.boolean(),
  clockSkew: z.boolean(),
});
export type Weighment = z.infer<typeof weighmentSchema>;

export const truckSchema = z.object({
  id: idSchema,
  subOrderId: idSchema,
  subOrderNumber: z.string(),
  orderId: idSchema,
  customerName: z.string().nullable(),
  companyId: idSchema,
  companyCode: z.string(),
  plantId: idSchema,
  plantName: z.string(),
  vehicleNo: z.string(),
  transporter: refSchema.nullable(),
  driverName: z.string(),
  driverPhone: z.string(),
  lrNo: z.string().nullable(),
  state: truckStateSchema,
  plan: z.array(
    z.object({
      orderLineId: idSchema,
      productName: z.string(),
      length: lengthSchema.nullable(),
      plannedKg: z.number().int(),
    }),
  ),
  tareKg: z.number().int().nullable(),
  grossKg: z.number().int().nullable(),
  netKg: z.number().int().nullable(),
  allocations: z.array(allocationSchema),
  loadingSlipNo: z.string().nullable(),
  assignedAt: z.string(),
  assignedBy: refSchema,
  atGateAt: z.string().nullable(),
  tareAt: z.string().nullable(),
  /** Business time the weights were saved (TON-57: the truck then awaits approval); null before. */
  weighedAt: z.string().nullable(),
  /** The office's approval: the dispatch. */
  dispatchedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  earningRupees: z.number().int().optional(),
  weighments: z.array(weighmentSchema),
  warnings: z.array(z.enum(['VEHICLE_BUSY', 'OVER_ASSIGNABLE'])).optional(),
  version: versionSchema,
});
export type Truck = z.infer<typeof truckSchema>;

/** `weighed` = "To approve" (TON-57). `open` lists every open truck, weighed first. */
export const DISPATCH_STATES = ['open', 'assigned', 'at_gate', 'loading', 'weighed', 'dispatched_today'] as const;
export const dispatchQuerySchema = z.object({
  companyId: idSchema.optional(),
  state: z.enum(DISPATCH_STATES).default('open'),
  q: z.string().trim().max(60).optional(),
});
export type DispatchQuery = z.infer<typeof dispatchQuerySchema>;

export const recentVehicleSchema = z.object({
  vehicleNo: z.string(),
  transporterId: idSchema.nullable(),
  driverName: z.string(),
  driverPhone: z.string(),
});
export type RecentVehicle = z.infer<typeof recentVehicleSchema>;

export const dispatchBoardSchema = z.object({
  counts: z.object({
    assigned: z.number().int(),
    at_gate: z.number().int(),
    loading: z.number().int(),
    weighed: z.number().int(),
    dispatched_today: z.number().int(),
  }),
  items: z.array(truckSchema.omit({ weighments: true })),
});
export type DispatchBoard = z.infer<typeof dispatchBoardSchema>;

export const taskSchema = z.object({
  truckId: idSchema,
  vehicleNo: z.string(),
  transporterName: z.string().nullable(),
  driverName: z.string(),
  driverPhone: z.string(),
  customerName: z.string().nullable(),
  subOrderNumber: z.string(),
  companyCode: z.string(),
  state: truckStateSchema,
  tareKg: z.number().int().nullable(),
  /** Business time (`capturedAt`) of the live (not superseded) tare; null before one. */
  tareAt: z.string().nullable(),
  tareDeviceId: z.string().nullable(),
  plan: z.array(z.object({ orderLineId: idSchema, productName: z.string(), plannedKg: z.number().int() })),
  /**
   * Every line of the truck's sub-order (TON-57 "Add product"): a supervisor may weigh a line that
   * is not on the plan. Defaults to none so tasks stored on a phone before it still parse.
   */
  lines: z
    .array(z.object({ orderLineId: idSchema, productName: z.string(), pendingKg: z.number().int() }))
    .default([]),
  version: versionSchema,
  changedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

export const tasksPageSchema = z.object({
  items: z.array(taskSchema),
  removed: z.array(idSchema),
  /**
   * Event ids of the caller's own refused events the owner restored or dismissed at or after the
   * cursor (every resolved one on a pull without a cursor): the phone stops holding them.
   */
  resolved: z.array(idSchema),
  /**
   * Trucks purged with their order (hard delete) at or after the cursor; within the last 30 days on a
   * pull without a cursor. Every waiting outbox row of theirs is over: the owner erased the order.
   */
  deleted: z.array(idSchema),
  cursor: z.string(),
  serverTime: z.string(),
});
export type TasksPage = z.infer<typeof tasksPageSchema>;

/**
 * Trucks this plant weighed today (IST, by `weighedAt`). TON-57: each awaits the office's approval
 * until it is dispatched; slip and dispatch time come with the approval.
 */
export const doneTodaySchema = z.object({
  items: z.array(
    z.object({
      truckId: idSchema,
      vehicleNo: z.string(),
      customerName: z.string().nullable(),
      subOrderNumber: z.string(),
      netKg: z.number().int(),
      status: z.enum(['awaiting_approval', 'dispatched']),
      weighedAt: z.string(),
      loadingSlipNo: z.string().nullable(),
      dispatchedAt: z.string().nullable(),
    }),
  ),
  totalNetKg: z.number().int(),
});
export type DoneToday = z.infer<typeof doneTodaySchema>;

const eventBase = {
  eventId: idSchema,
  truckId: idSchema,
  deviceSeq: z.number().int().min(0),
  capturedAtDevice: z.iso.datetime({ offset: true }),
};

export const syncEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('AT_GATE') }).strict(),
  z.object({ ...eventBase, type: z.literal('TARE'), tareKg: weightKgSchema }).strict(),
  z
    .object({ ...eventBase, type: z.literal('GROSS'), grossKg: weightKgSchema, allocations: allocationsInputSchema })
    .strict(),
]);
export type SyncEvent = z.infer<typeof syncEventSchema>;

export const syncBodySchema = z
  .object({ deviceId: z.string().min(8).max(64), events: z.array(syncEventSchema).min(1).max(100) })
  .strict();
export type SyncBody = z.infer<typeof syncBodySchema>;

export const SYNC_REJECT_CODES = [
  'PLANT_SCOPE', 'TARE_CONFLICT', 'TRUCK_CANCELLED', 'INVALID_WEIGHT', 'ALLOC_MISMATCH',
  'LINE_REMOVED', 'TARE_REQUIRED', 'ALREADY_DISPATCHED', 'INVALID_STATE',
  // TON-57: the truck must be marked arrived (`AT_GATE`) before its tare.
  'ARRIVAL_REQUIRED',
  // TON-57 revised: weights already saved; the office approves or changes them, not the phone.
  'ALREADY_WEIGHED',
] as const;
export const syncRejectCodeSchema = z.enum(SYNC_REJECT_CODES);
export type SyncRejectCode = z.infer<typeof syncRejectCodeSchema>;

export const syncResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    eventId: idSchema,
    task: taskSchema.nullable(),
    loadingSlipNo: z.string().optional(),
  }),
  z.object({ status: z.literal('duplicate'), eventId: idSchema }),
  z.object({
    status: z.literal('rejected'),
    eventId: idSchema,
    code: syncRejectCodeSchema,
    message: z.string(),
    server: z
      .object({
        tareKg: z.number().int().optional(),
        by: z.string().optional(),
        at: z.string().optional(),
        state: truckStateSchema.optional(),
      })
      .optional(),
  }),
]);
export type SyncResult = z.infer<typeof syncResultSchema>;

export const syncResponseSchema = z.object({ results: z.array(syncResultSchema), serverTime: z.string() });
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const rejectionSchema = z.object({
  id: idSchema,
  truckId: idSchema,
  vehicleNo: z.string(),
  subOrderNumber: z.string(),
  plantName: z.string(),
  user: refSchema,
  eventType: z.enum(['AT_GATE', 'TARE', 'GROSS']),
  /** Kg fields only. */
  payload: z.record(z.string(), z.unknown()),
  code: syncRejectCodeSchema,
  serverState: truckStateSchema,
  status: z.enum(['open', 'restored', 'dismissed']),
  createdAt: z.string(),
  resolvedBy: refSchema.nullable(),
  resolutionNote: z.string().nullable(),
});
export type Rejection = z.infer<typeof rejectionSchema>;

export const rejectionsQuerySchema = z.object({ status: z.enum(['open', 'all']).default('open') });
export type RejectionsQuery = z.infer<typeof rejectionsQuerySchema>;

export const rejectionCountSchema = z.object({ open: z.number().int().min(0) });
export type RejectionCount = z.infer<typeof rejectionCountSchema>;

/** `POST /weighment-rejections/:id/restore`: the restored rejection and its truck afterwards. */
/** `warnings`: computed as on assign when the restore reinstates a cancelled truck. */
export const restoreRejectionResultSchema = z.object({
  rejection: rejectionSchema,
  truck: truckSchema,
  warnings: z.array(z.enum(['VEHICLE_BUSY', 'OVER_ASSIGNABLE'])).optional(),
});
export type RestoreRejectionResult = z.infer<typeof restoreRejectionResultSchema>;

export const dismissRejectionBodySchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
export type DismissRejectionBody = z.infer<typeof dismissRejectionBodySchema>;

/** `POST /v1/trucks/:id/approve` (TON-57): the office approves a weighed truck; that is the dispatch. */
export const approveTruckBodySchema = z.object({ version: versionSchema }).strict();
export type ApproveTruckBody = z.infer<typeof approveTruckBodySchema>;

/** Changes a weighed (awaiting approval) or dispatched truck's weights (owner, city staff). */
export const correctWeightBodySchema = z
  .object({
    tareKg: weightKgSchema,
    grossKg: weightKgSchema,
    allocations: allocationsInputSchema,
    reason: z.string().trim().min(3).max(200),
    version: versionSchema,
  })
  .strict();
export type CorrectWeightBody = z.infer<typeof correctWeightBodySchema>;
