import { type Action, type Role, can } from '@tonnage/shared';
import type { TargetId } from './tours';

/** Board 45: one small tip the first time a screen opens. The key is the target it points at. */
export interface Tip {
  key: TargetId;
  title: string;
  body: string;
  requires?: Action;
}

export const TIPS: Tip[] = [
  {
    key: 'order.requestVehicle',
    title: 'Need a truck? Ask for one here',
    body: 'Call or WhatsApp the broker or customer. The material and quantity are filled in for you.',
    requires: 'truck.assign',
  },
  {
    key: 'dispatch.toApprove',
    title: 'Trucks waiting for you',
    body: 'Trucks with saved weights wait here. Approving one dispatches it.',
    requires: 'dispatch.approve',
  },
  {
    key: 'truck.supervisors',
    title: 'Talk to the plant',
    body: 'Call or WhatsApp the plant’s supervisor from here.',
    requires: 'dispatch.view',
  },
  {
    key: 'ledger.recordPayment',
    title: 'Paid a broker?',
    body: 'Record the payment with TDS. The due updates at once.',
    requires: 'broker.pay',
  },
  {
    key: 'reports.firstTile',
    title: 'Pick a report',
    body: 'Choose the dates, then Share it as a message.',
    requires: 'reports.view',
  },
  {
    key: 'attention.first',
    title: 'Weights the server refused',
    body: 'Open one to restore it or dismiss it with a reason.',
    requires: 'rejections.manage',
  },
  {
    key: 'notifications.list',
    title: 'Everything that happened',
    body: 'Tap a notification to open its order or truck.',
  },
  {
    key: 'weigh.lines',
    title: 'One weight per product',
    body: 'Type each product’s weight. Gross is added up for you.',
    requires: 'tasks.view',
  },
  {
    key: 'done.list',
    title: 'Saved on this phone',
    body: 'Everything here syncs by itself when you are online.',
    requires: 'tasks.view',
  },
];

export function tipFor(role: Role, key: TargetId): Tip | undefined {
  const tip = TIPS.find((t) => t.key === key);
  return tip && (!tip.requires || can(role, tip.requires)) ? tip : undefined;
}
