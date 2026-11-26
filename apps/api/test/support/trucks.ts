import type { TruckState } from '@tonnage/shared';
import { and, asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../../src/db/client.ts';
import { orderLines, orders, plants, subOrders, truckAllocations, truckPlanLines, trucks } from '../../src/db/schema/index.ts';

/** The mock's `AddTruckInput`, less the demo-seed extras. */
export interface TruckInput {
  subOrderId: string;
  state: TruckState;
  vehicleNo: string;
  tareKg?: number;
  plan: { orderLineId: string; plannedKg: number }[];
  allocations?: { orderLineId: string; netKg: number }[];
  transporterId?: string | null;
}

const MINUTE = 60_000;
/** Earlier steps of an inserted truck, before the time of its latest step (as the mock's `addTruck`). */
const STEP_BEFORE = { assigned: 90 * MINUTE, atGate: 60 * MINUTE, tare: 45 * MINUTE } as const;

/**
 * Inserts a truck in any state through the owner connection, as the mock's `addTruck` builds it
 * (the same times, plant and people), without weighments, slips or ledger rows (B3/B4 tables).
 * Trucks arrive with B3's routes; until then tests (and Task 7's contract fixture) insert them here.
 */
export async function ownerInsertTruck(ownerDb: Db, input: TruckInput, nowMs: number): Promise<string> {
  return ownerDb.transaction(async (tx) => {
    const [sub] = await tx
      .select({ sub: subOrders, createdBy: orders.createdBy })
      .from(subOrders)
      .innerJoin(orders, and(eq(orders.tenantId, subOrders.tenantId), eq(orders.id, subOrders.orderId)))
      .where(eq(subOrders.id, input.subOrderId));
    if (!sub) throw new Error(`ownerInsertTruck: unknown sub-order ${input.subOrderId}`);
    // The mock's refusals: inputs the real flow could never produce.
    const lineIds = new Set(
      (
        await tx
          .select({ id: orderLines.id })
          .from(orderLines)
          .where(and(eq(orderLines.tenantId, sub.sub.tenantId), eq(orderLines.subOrderId, sub.sub.id)))
      ).map((l) => l.id),
    );
    for (const row of [...input.plan, ...(input.allocations ?? [])]) {
      if (!lineIds.has(row.orderLineId)) {
        throw new Error(`ownerInsertTruck: line ${row.orderLineId} is not on sub-order ${sub.sub.id}`);
      }
    }
    const hasWeights = input.state === 'dispatched' || input.state === 'weighed';
    const allocationCount = input.allocations?.length ?? 0;
    if (hasWeights && (allocationCount === 0 || input.tareKg === undefined)) {
      throw new Error(`ownerInsertTruck: a ${input.state} truck needs a tare and allocations`);
    }
    if (!hasWeights && allocationCount > 0) {
      throw new Error('ownerInsertTruck: only a weighed or dispatched truck has allocations');
    }
    const [plant] = await tx
      .select({ id: plants.id })
      .from(plants)
      .where(and(eq(plants.tenantId, sub.sub.tenantId), eq(plants.companyId, sub.sub.companyId), eq(plants.active, true)))
      .orderBy(asc(plants.createdAt), asc(plants.id))
      .limit(1);
    if (!plant) throw new Error(`ownerInsertTruck: company ${sub.sub.companyId} has no active plant`);

    const s = input.state;
    const allocations = input.allocations ?? [];
    const booked = sub.sub.createdAt.getTime();
    const stepAt = (before: number) => new Date(Math.max(booked, nowMs - before));
    const at = new Date(nowMs);
    const tareKg = input.tareKg ?? null;
    const net = allocations.reduce((n, a) => n + a.netKg, 0);
    const assignedAt = s === 'assigned' ? at : stepAt(STEP_BEFORE.assigned);
    const id = uuidv7();
    const tenantId = sub.sub.tenantId;
    await tx.insert(trucks).values({
      id,
      tenantId,
      orderId: sub.sub.orderId,
      subOrderId: sub.sub.id,
      plantId: plant.id,
      vehicleNo: input.vehicleNo,
      transporterId: input.transporterId ?? null,
      driverName: 'Driver',
      driverPhone: '',
      lrNo: null,
      state: s,
      tareKg,
      grossKg: hasWeights && tareKg !== null ? tareKg + net : null,
      loadingSlipNo: null,
      assignedAt,
      assignedBy: sub.createdBy,
      atGateAt: s === 'at_gate' ? at : s === 'assigned' ? null : stepAt(STEP_BEFORE.atGate),
      tareAt: tareKg === null ? null : hasWeights ? stepAt(STEP_BEFORE.tare) : at,
      tareDeviceId: tareKg === null ? null : 'fixture',
      weighedAt: hasWeights ? at : null,
      dispatchedAt: s === 'dispatched' ? at : null,
      cancelledAt: s === 'cancelled' ? at : null,
      cancelledBy: s === 'cancelled' ? sub.createdBy : null,
      cancelReason: s === 'cancelled' ? 'Cancelled' : null,
      createdAt: assignedAt,
      updatedAt: at,
    });
    const stamps = { createdAt: at, updatedAt: at };
    if (input.plan.length > 0) {
      await tx.insert(truckPlanLines).values(
        input.plan.map((p, position) => ({ tenantId, truckId: id, orderLineId: p.orderLineId, position, plannedKg: p.plannedKg, ...stamps })),
      );
    }
    if (allocations.length > 0) {
      await tx.insert(truckAllocations).values(
        allocations.map((a, position) => ({ tenantId, truckId: id, orderLineId: a.orderLineId, position, netKg: a.netKg, ...stamps })),
      );
    }
    return id;
  });
}
