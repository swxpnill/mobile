import { type Action, type Role, can } from '@tonnage/shared';
import { type TabKey, tabsForRole } from '../nav/tabs';
import type { IconName, Tone } from '../ui';

/** Everything a tour step or a tip can point at. Each is a `TourTarget` on a real screen. */
export type TargetId =
  | 'home.units'
  | 'home.pending'
  | 'home.inPlant'
  | 'home.bell'
  | 'tab.home'
  | 'tab.orders'
  | 'tab.new'
  | 'tab.dispatch'
  | 'tab.more'
  | 'tab.tasks'
  | 'tab.done'
  | 'tab.profile'
  | 'tasks.counts'
  | 'tasks.arrived'
  | 'tasks.tare'
  | 'tasks.weigh'
  | 'order.requestVehicle'
  | 'dispatch.toApprove'
  | 'truck.supervisors'
  | 'ledger.recordPayment'
  | 'reports.firstTile'
  | 'attention.first'
  | 'notifications.list'
  | 'weigh.lines'
  | 'done.list';

export interface TourStep {
  id: string;
  /** No target: the card shows centred with nothing highlighted. */
  target?: TargetId;
  tag: string;
  title: string;
  body: string;
  requires?: Action;
}

export const ROLE_TOUR_NAME: Record<Role, string> = {
  owner: 'Owner',
  city_staff: 'City staff',
  plant_head: 'Plant head',
  supervisor: 'Supervisor',
};

const UNITS: TourStep = {
  id: 'units',
  target: 'home.units',
  tag: 'Units',
  title: 'Switch between your companies',
  body: 'See all units together, or tap to focus on one. Every screen follows this choice.',
};
const PENDING: TourStep = {
  id: 'pending',
  target: 'home.pending',
  tag: 'Pending',
  title: 'What still has to go out',
  body: 'Booked but not yet dispatched, split by company. The amber tag flags orders waiting too long.',
};
const LIVE: TourStep = {
  id: 'live',
  target: 'home.inPlant',
  tag: 'Live',
  title: 'Trucks in your plants now',
  body: 'Every truck that has arrived, is weighed or loading, live from the supervisors. Tap one to see its weights.',
};
const CREATE: TourStep = {
  id: 'create',
  target: 'tab.new',
  tag: 'Create',
  title: 'New: one tap for everything',
  body: 'Book an order, assign a loading, or add a customer, broker, product or transporter.',
  requires: 'order.create',
};
const ORDERS: TourStep = {
  id: 'orders',
  target: 'tab.orders',
  tag: 'Orders',
  title: 'Every order in one list',
  body: 'Split across companies. Track dispatched against pending, edit or short close any time.',
};
const DISPATCH: TourStep = {
  id: 'dispatch',
  target: 'tab.dispatch',
  tag: 'Dispatch',
  title: 'The loading board',
  body: 'Trucks by stage. When a supervisor saves the weights, the truck waits in To approve: your approval dispatches it and gives the loading slip number.',
  requires: 'dispatch.approve',
};
const DONE_OFFICE: TourStep = {
  id: 'done',
  tag: 'Done',
  title: 'You’re all set, {name}',
  body: 'That’s the tour. A small tip appears the first time you open a new screen.',
};

const TOURS: Record<Role, TourStep[]> = {
  owner: [
    UNITS,
    PENDING,
    LIVE,
    CREATE,
    ORDERS,
    DISPATCH,
    {
      id: 'more',
      target: 'tab.more',
      tag: 'More',
      title: 'Masters, money and help',
      body: 'Customers, brokers, products, broker ledger, reports and Needs attention live here. Replay this tour from Help & tour.',
    },
    DONE_OFFICE,
  ],
  city_staff: [
    UNITS,
    PENDING,
    CREATE,
    ORDERS,
    DISPATCH,
    {
      id: 'more',
      target: 'tab.more',
      tag: 'More',
      title: 'Money and help',
      body: 'Broker ledger and payments, reports and masters live here. Replay this tour from Help & tour.',
    },
    DONE_OFFICE,
  ],
  plant_head: [
    {
      id: 'home',
      target: 'home.pending',
      tag: 'Home',
      title: 'Your plants at a glance',
      body: 'What is still to go out from your plants. Prices stay with the office.',
    },
    {
      id: 'live',
      target: 'home.inPlant',
      tag: 'Live',
      title: 'Trucks in your plants now',
      body: 'Every truck that has arrived, is weighed or loading. Tap one to see where it is.',
    },
    {
      id: 'orders',
      target: 'tab.orders',
      tag: 'Orders',
      title: 'Orders for your plants',
      body: 'Every order with material from your plants, and how much is pending.',
    },
    {
      id: 'dispatch',
      target: 'tab.dispatch',
      tag: 'Dispatch',
      title: 'Follow every truck',
      body: 'Trucks at your plants by stage, from assigned to dispatched.',
    },
    {
      id: 'more',
      target: 'tab.more',
      tag: 'More',
      title: 'Help and settings',
      body: 'Theme, text size, units, and Help & tour to replay this.',
    },
    {
      id: 'done',
      tag: 'Done',
      title: 'You’re all set, {name}',
      body: 'A small tip appears the first time you open a new screen.',
    },
  ],
  supervisor: [
    {
      id: 'today',
      target: 'tasks.counts',
      tag: 'Today',
      title: 'Your plant at a glance',
      body: 'Trucks waiting for tare, trucks loading, and what you finished today. Only your plant.',
    },
    {
      id: 'arrived',
      target: 'tasks.arrived',
      tag: 'Step 1',
      title: 'Tap “Vehicle arrived” at the gate',
      body: 'When the truck reaches the plant, mark it arrived first. The office sees it straight away.',
    },
    {
      id: 'tare',
      target: 'tasks.tare',
      tag: 'Step 2',
      title: 'Capture tare (empty truck)',
      body: 'Unlocks after arrival. Read the weighbridge and type the empty-truck weight.',
    },
    {
      id: 'weigh',
      target: 'tasks.weigh',
      tag: 'Step 3',
      title: 'Enter each product’s weight',
      body: 'After loading, type the weight of every product on the truck. Gross is added up for you.',
    },
    {
      id: 'approval',
      tag: 'Step 4',
      title: 'The office approves',
      body: 'After you save, the truck waits for approval. The owner or city staff approve it and it is dispatched. Your part is done.',
    },
    {
      id: 'done',
      target: 'tab.done',
      tag: 'Done',
      title: 'See what you finished',
      body: 'Every truck you weighed today. Works offline: it syncs when the network is back.',
    },
    {
      id: 'ready',
      tag: 'Ready',
      title: 'You’re all set, {name}',
      body: 'Replay this anytime from Profile → Help & tour.',
    },
  ],
};

/** The role's tour: steps it may use, `{name}` filled in. */
export function stepsFor(role: Role, firstName: string): TourStep[] {
  const tabs = tabsForRole(role);
  return TOURS[role]
    .filter((s) => !s.requires || can(role, s.requires))
    .filter((s) => !s.target?.startsWith('tab.') || tabs.includes(s.target.slice(4) as TabKey))
    .map((s) => ({ ...s, title: s.title.replace('{name}', firstName), body: s.body.replace('{name}', firstName) }));
}

/** Steps counted for "Owner · 7 steps · about 1 min" (the closing card is not a step). */
export function tourSummary(role: Role): { steps: number; minutes: 1 } {
  return { steps: stepsFor(role, '').length - 1, minutes: 1 };
}

export interface IntroPoint {
  icon: IconName;
  tone: Tone;
  title: string;
  body: string;
}

const TRACK: IntroPoint = {
  icon: 'truck',
  tone: 'am',
  title: 'Follow every truck, gate to dispatch',
  body: 'Weights come in live from your plants.',
};
const BOOK: IntroPoint = {
  icon: 'orders',
  tone: 'bl',
  title: 'Book orders across all your companies',
  body: 'One order, split by company.',
};

/** Board 42: what this role can do, three points. */
export const INTRO: Record<Role, { lead: string; points: IntroPoint[] }> = {
  owner: {
    lead: 'here’s what you can do as Owner',
    points: [
      BOOK,
      TRACK,
      { icon: 'chart', tone: 'vi', title: 'Brokers, dues and reports', body: 'Commission and overprice worked out for you.' },
    ],
  },
  city_staff: {
    lead: 'here’s what you can do as City staff',
    points: [
      BOOK,
      TRACK,
      { icon: 'wallet', tone: 'vi', title: 'Approve and record payments', body: 'Approve weighed trucks and keep broker dues right.' },
    ],
  },
  plant_head: {
    lead: 'here’s what you can do as Plant head',
    points: [
      { icon: 'orders', tone: 'bl', title: 'Your plants’ orders', body: 'What is pending from your plants.' },
      { icon: 'truck', tone: 'am', title: 'Trucks in your plants', body: 'Every truck by stage, live.' },
      { icon: 'shield', tone: 'gr', title: 'No prices', body: 'You see weights and trucks, the office sees money.' },
    ],
  },
  supervisor: {
    lead: 'here’s what you can do as Supervisor',
    points: [
      { icon: 'factory', tone: 'bl', title: 'Your plant’s trucks', body: 'Only the trucks assigned to your plant.' },
      { icon: 'scales', tone: 'am', title: 'Arrive, tare, product weights', body: 'Three steps per truck.' },
      { icon: 'wifiOff', tone: 'gr', title: 'Works offline', body: 'Saves on the phone and syncs later.' },
    ],
  },
};
