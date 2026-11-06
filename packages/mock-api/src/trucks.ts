import type { TruckState } from '@tonnage/shared';
import { toIso } from './clock.ts';
import type { MockState, TruckRec } from './store.ts';
import { newId } from './views.ts';

export interface AddTruckInput {
  subOrderId: string;
  state: TruckState;
  vehicleNo: string;
  tareKg?: number;
  plan: { orderLineId: string; plannedKg: number }[];
  allocations?: { orderLineId: string; netKg: number }[];
}

/**
 * Test and demo hook until F3 builds real assignment and weighing: inserts a truck in any state.
 * Refuses inputs the real flow could never produce (unknown sub-order, lines of another
 * sub-order, a dispatched truck without allocations) so fixtures cannot fake impossible data.
 */
export function addTruck(state: MockState, input: AddTruckInput, nowMs: number): string {
  const sub = state.subOrders.find((s) => s.id === input.subOrderId);
  if (!sub) throw new Error(`addTruck: unknown sub-order ${input.subOrderId}`);
  const lineIds = new Set(state.orderLines.filter((l) => l.subOrderId === sub.id).map((l) => l.id));
  const allocations = input.allocations ?? [];
  for (const row of [...input.plan, ...allocations]) {
    if (!lineIds.has(row.orderLineId)) {
      throw new Error(`addTruck: line ${row.orderLineId} is not on sub-order ${sub.id}`);
    }
  }
  if (input.state === 'dispatched' && allocations.length === 0) {
    throw new Error('addTruck: a dispatched truck needs allocations');
  }
  if (input.state !== 'dispatched' && allocations.length > 0) {
    throw new Error('addTruck: only a dispatched truck has allocations');
  }
  const plant = state.plants.find((p) => p.companyId === sub.companyId && p.active);
  if (!plant) throw new Error(`addTruck: company ${sub.companyId} has no active plant`);
  const at = toIso(nowMs);
  const rec: TruckRec = {
    id: newId(),
    tenantId: sub.tenantId,
    subOrderId: sub.id,
    plantId: plant.id,
    vehicleNo: input.vehicleNo,
    state: input.state,
    tareKg: input.tareKg ?? null,
    plan: input.plan.map((r) => ({ ...r })),
    allocations: allocations.map((r) => ({ ...r })),
    dispatchedAt: input.state === 'dispatched' ? at : null,
    cancelledAt: input.state === 'cancelled' ? at : null,
    cancelReason: input.state === 'cancelled' ? 'Cancelled' : null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  state.trucks.push(rec);
  return rec.id;
}
