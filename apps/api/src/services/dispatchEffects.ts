import type { Tx } from '../db/client.ts';
import type { OrderWriteCtx } from './orderEdit.ts';

/**
 * Side effects of dispatch writes that belong to B4 (B3 Ruling 6): notification rows and push
 * outbox entries, as the mock's `notify*` calls make them. Each runs inside the write's transaction,
 * after it. They do nothing in B3; the one M3 case that reads notifications is skipped until B4.
 */

/** The mock's `notifyTruckAssigned`: the plant's supervisors (and a silent sync push). */
export async function afterTruckAssigned(tx: Tx, c: OrderWriteCtx, truckId: string): Promise<void> {
  void tx;
  void c;
  void truckId;
}

/** The mock's `notifyTruckChanged`: a silent sync push to the plant's phones. */
export async function afterTruckChanged(tx: Tx, c: OrderWriteCtx, truckId: string): Promise<void> {
  void tx;
  void c;
  void truckId;
}

/** The mock's `notifyArrived`: plant head alerted; owner and city staff a row only. */
export async function afterArrived(tx: Tx, c: OrderWriteCtx, truckId: string): Promise<void> {
  void tx;
  void c;
  void truckId;
}

/** The mock's `notifyWeighed`: owner and city staff asked to approve. */
export async function afterWeighed(tx: Tx, c: OrderWriteCtx, truckId: string, netKg: number): Promise<void> {
  void tx;
  void c;
  void truckId;
  void netKg;
}

/** The mock's `notifyDispatched`: everyone concerned except the approver. */
export async function afterDispatched(tx: Tx, c: OrderWriteCtx, truckId: string, netKg: number): Promise<void> {
  void tx;
  void c;
  void truckId;
  void netKg;
}

/** The mock's `notifyOverTolerance`: a sub-order loaded beyond the tolerance. */
export async function afterOverTolerance(tx: Tx, c: OrderWriteCtx, subOrderId: string, overKg: number): Promise<void> {
  void tx;
  void c;
  void subOrderId;
  void overKg;
}

/** The mock's `notifyRejection`: owner told of a weight in Needs attention. */
export async function afterRejection(tx: Tx, c: OrderWriteCtx, rejectionId: string): Promise<void> {
  void tx;
  void c;
  void rejectionId;
}
