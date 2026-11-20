import type { DoneToday, Task } from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { type OutboxRow, displayTasks } from './deviceStore';
import { useDeviceRevision, useDeviceStore } from './useSync';

export type DisplayTask = Task & { localPending: boolean };

/** What the supervisor screens read from the device store, as one consistent read. */
export interface DeviceSnapshot {
  /** Server tasks as stored (a truck with an unsent gross is still here). */
  tasks: Task[];
  /** The list as the phone shows it: unsent events applied (`displayTasks`). */
  shown: DisplayTask[];
  outbox: OutboxRow[];
  doneToday: DoneToday | null;
}

/**
 * The signed-in user's device store, read again after every save and sync run. `null` until the
 * sync loop has opened the store (or when it could not be opened).
 */
export function useDeviceSnapshot(): DeviceSnapshot | null {
  const store = useDeviceStore((s) => s.store);
  const rev = useDeviceRevision((s) => s.rev);
  const [snap, setSnap] = useState<DeviceSnapshot | null>(null);

  useEffect(() => {
    if (!store) {
      setSnap(null);
      return;
    }
    let live = true;
    void Promise.all([store.getTasks(), store.outbox(), store.getDoneToday()])
      .then(([tasks, outbox, doneToday]) => {
        if (live) setSnap({ tasks, shown: displayTasks(tasks, outbox), outbox, doneToday });
      })
      .catch(() => undefined); // keep the last good read; the next revision tries again
    return () => {
      live = false;
    };
  }, [store, rev]);

  return snap;
}

const UNSENT: OutboxRow['status'][] = ['pending', 'sending'];

type DoneItem = NonNullable<DeviceSnapshot['doneToday']>['items'][number];

/**
 * When the truck was weighed. A done-today list stored on the phone before TON-57's approval step
 * has no `weighedAt`; its trucks were weighed when they were dispatched.
 */
const weighedAtOf = (i: DoneItem): string => (i as Partial<DoneItem>).weighedAt ?? i.dispatchedAt ?? '';

/** Dispatched by the office. A list stored before TON-57 has no status: a slip meant dispatched. */
export const isApproved = (i: DoneItem): boolean =>
  ((i as Partial<DoneItem>).status ?? (i.loadingSlipNo ? 'dispatched' : 'awaiting_approval')) === 'dispatched';

const netOf = (row: OutboxRow) =>
  (row.payload.allocations ?? []).reduce((sum, a) => sum + a.netKg, 0);

export interface DoneRow {
  truckId: string;
  vehicleNo: string;
  customerName: string | null;
  subOrderNumber: string;
  /** Known only for trucks weighed on this phone and not yet synced. */
  productName: string | null;
  netKg: number;
  at: string;
  slipNo: string | null;
  synced: boolean;
}

/**
 * Done today (canvas 35): the server's list plus this phone's gross weights not sent yet,
 * newest first. Allocations always sum to net, so a local row's net is their sum.
 */
export function doneRows(snap: DeviceSnapshot): {
  rows: DoneRow[];
  totalNetKg: number;
  waiting: number;
} {
  const server = snap.doneToday?.items ?? [];
  const onServer = new Set(server.map((i) => i.truckId));
  const rows: DoneRow[] = server.map((i) => ({
    truckId: i.truckId,
    vehicleNo: i.vehicleNo,
    customerName: i.customerName,
    subOrderNumber: i.subOrderNumber,
    productName: null,
    netKg: i.netKg,
    at: weighedAtOf(i),
    slipNo: i.loadingSlipNo,
    synced: true,
  }));
  let waiting = 0;
  for (const r of snap.outbox) {
    if (r.type !== 'GROSS' || !UNSENT.includes(r.status) || onServer.has(r.truckId)) continue;
    const task = snap.tasks.find((t) => t.truckId === r.truckId);
    if (!task) continue;
    waiting += 1;
    rows.push({
      truckId: r.truckId,
      vehicleNo: task.vehicleNo,
      customerName: task.customerName,
      subOrderNumber: task.subOrderNumber,
      productName: task.plan[0]?.productName ?? null,
      netKg: netOf(r),
      at: r.capturedAtDevice,
      slipNo: null,
      synced: false,
    });
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { rows, totalNetKg: rows.reduce((s, r) => s + r.netKg, 0), waiting };
}

export interface DispatchedView {
  vehicleNo: string;
  customerName: string | null;
  subOrderNumber: string;
  netKg: number;
  at: string;
  slipNo: string | null;
  /** waiting: saved on this phone, not sent; synced: the server took it; rejected: the owner decides. */
  sync: 'waiting' | 'synced' | 'rejected';
  /** TON-57: the office approved the weights; that is the dispatch (and the loading slip). */
  approved: boolean;
}

/** One dispatched truck (canvas 13), from the server's done today or this phone's gross weight. */
export function dispatchedView(snap: DeviceSnapshot, truckId: string): DispatchedView | null {
  const item = snap.doneToday?.items.find((i) => i.truckId === truckId);
  if (item) {
    return {
      vehicleNo: item.vehicleNo,
      customerName: item.customerName,
      subOrderNumber: item.subOrderNumber,
      netKg: item.netKg,
      at: item.dispatchedAt ?? weighedAtOf(item),
      slipNo: item.loadingSlipNo,
      sync: 'synced',
      approved: isApproved(item),
    };
  }
  // A resolved row is the owner's call made on the server: it says nothing about this phone.
  const row = snap.outbox
    .filter((r) => r.truckId === truckId && r.type === 'GROSS' && r.status !== 'resolved')
    .at(-1);
  const task = snap.tasks.find((t) => t.truckId === truckId);
  if (!row || !task) return null;
  return {
    vehicleNo: task.vehicleNo,
    customerName: task.customerName,
    subOrderNumber: task.subOrderNumber,
    netKg: netOf(row),
    at: row.capturedAtDevice,
    slipNo: null,
    sync: row.status === 'rejected' || row.status === 'blocked' ? 'rejected' : 'waiting',
    approved: false,
  };
}
