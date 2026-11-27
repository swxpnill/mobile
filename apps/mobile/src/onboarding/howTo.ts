import { type Action, type Role, can } from '@tonnage/shared';
import type { Href } from 'expo-router';

/** Board 46 "How do I…": short answers, the steps naming the app's real buttons. */
export interface HowTo {
  id: string;
  title: string;
  steps: string[];
  showMe?: Href;
  requires?: Action;
}

const OFFICE: HowTo[] = [
  {
    id: 'book-order',
    title: 'Book one order across companies',
    requires: 'order.create',
    showMe: '/order-form',
    steps: [
      'Tap New, then Order.',
      'Choose the customer, and the broker if there is one.',
      'Add each product with its company, quantity and rate.',
      'Check the review and tap Save. The order splits by company on its own.',
    ],
  },
  {
    id: 'request-vehicle',
    title: 'Ask a broker or customer for a truck',
    requires: 'truck.assign',
    steps: [
      'Open the order.',
      'Tap Request vehicle.',
      'Pick who to ask and how much material.',
      'Tap Call or WhatsApp. The message is written for you.',
    ],
  },
  {
    id: 'approve',
    title: 'Approve a weighed truck',
    requires: 'dispatch.approve',
    showMe: '/dispatch',
    steps: [
      'Open Dispatch and tap To approve.',
      'Open the truck and check its weights.',
      'Tap Approve dispatch. The loading slip number is given and the truck is dispatched.',
    ],
  },
  {
    id: 'short-close',
    title: 'Short close an order',
    requires: 'order.shortClose',
    steps: [
      'Open the order.',
      'Tap ⋯ and choose Short close.',
      'Check the lines that will close and give a reason.',
      'Confirm. Open trucks on those lines are listed first.',
    ],
  },
  {
    id: 'record-payment',
    title: 'Record a broker payment',
    requires: 'broker.pay',
    showMe: '/brokers',
    steps: [
      'Open More, then Broker ledger.',
      'Choose the broker.',
      'Tap Record payment and fill in the amount, TDS and how it was paid.',
      'Save. The due changes at once.',
    ],
  },
  {
    id: 'fix-weight',
    title: 'Fix a wrong weight',
    requires: 'weighment.correct',
    steps: [
      'Open Dispatch and the truck.',
      'Tap the weights and change them.',
      'Give a reason and save. The broker earning is worked out again.',
    ],
  },
];

const PLANT_HEAD: HowTo[] = [
  {
    id: 'find-truck',
    title: 'Find a truck at my plant',
    requires: 'dispatch.view',
    showMe: '/dispatch',
    steps: [
      'Open Dispatch.',
      'Search by vehicle number, or tap a stage such as In plant.',
      'Open the truck to see its weights and progress.',
    ],
  },
  {
    id: 'pending',
    title: 'See what is pending for my plant',
    requires: 'order.view',
    showMe: '/orders',
    steps: [
      'Open Orders.',
      'Tap Open or Partial to see what still has to go out.',
      'Open an order to see each product’s pending quantity.',
    ],
  },
  {
    id: 'call-supervisor',
    title: 'Call a plant’s supervisor',
    requires: 'dispatch.view',
    steps: [
      'Open Dispatch and any truck at that plant.',
      'Scroll to Supervisors.',
      'Tap Call or WhatsApp.',
    ],
  },
];

const SUPERVISOR: HowTo[] = [
  {
    id: 'weigh',
    title: 'Weigh a truck',
    requires: 'weighment.capture',
    steps: [
      'When the truck reaches the gate, tap Vehicle arrived.',
      'Tap Capture tare weight and type the empty-truck weight.',
      'After loading, tap Capture gross weight and type each product’s weight.',
      'Save. The office approves it and the truck is dispatched.',
    ],
  },
  {
    id: 'add-product',
    title: 'Add another product to the truck',
    requires: 'weighment.capture',
    steps: [
      'While typing product weights, tap Add a product.',
      'Choose a product from the same order.',
      'Type its weight and save as usual.',
    ],
  },
  {
    id: 'offline',
    title: 'No network at the plant',
    requires: 'tasks.view',
    steps: [
      'Keep weighing as usual: everything is saved on the phone.',
      'The banner at the top shows what is waiting to send.',
      'It sends by itself when the network is back. Pull down on My tasks to try now.',
    ],
  },
  {
    id: 'refused',
    title: 'A weight was refused',
    requires: 'tasks.view',
    steps: [
      'The truck shows a message saying the office has to look at it.',
      'Nothing more is needed from you on that truck.',
      'The owner restores it or tells you what to do.',
    ],
  },
];

export function howToFor(role: Role): HowTo[] {
  const list = role === 'supervisor' ? SUPERVISOR : role === 'plant_head' ? PLANT_HEAD : OFFICE;
  return list.filter((h) => !h.requires || can(role, h.requires));
}
