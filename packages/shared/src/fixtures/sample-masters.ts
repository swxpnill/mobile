import type { PartyType } from '../schemas/masters.ts';
import type { Length } from '../products.ts';

/**
 * Canvas customers, brokers, transporters and products, as plain data with stable UUIDv7-shaped
 * ids (groups 0004 parties, 0005 products, 0006 contacts, 0007 addresses, 0008 numbers) so the
 * mock seed, contract tests and the B2 seed refer to the same records.
 */
const sid = (group: number, n: number) =>
  `019a4c00-${String(group).padStart(4, '0')}-7000-8000-${String(n).padStart(12, '0')}`;

const ids = {
  parties: {
    shubham: sid(4, 1),
    patel: sid(4, 2),
    krishna: sid(4, 3),
    gupta: sid(4, 4),
    rkAgarwal: sid(4, 5),
    mittal: sid(4, 6),
    shreeGanesh: sid(4, 7),
    golden: sid(4, 8),
  },
  products: {
    tmt8: sid(5, 1),
    tmt10: sid(5, 2),
    tmt12: sid(5, 3),
    tmt16: sid(5, 4),
    tmt20: sid(5, 5),
    tmt25: sid(5, 6),
    billet: sid(5, 7),
    ingot: sid(5, 8),
    angle: sid(5, 9),
    channel: sid(5, 10),
  },
  addresses: {
    shubhamBill: sid(7, 1),
    shubhamHingna: sid(7, 2),
    shubhamButibori: sid(7, 3),
    shubhamKamptee: sid(7, 4),
    patelBill: sid(7, 5),
    patelSite2: sid(7, 6),
    krishnaBill: sid(7, 7),
    krishnaSite: sid(7, 8),
    guptaBill: sid(7, 9),
    guptaShop: sid(7, 10),
  },
} as const;

export interface SampleContact {
  id: string;
  name: string;
  roleLabel: string;
  numbers: { id: string; number: string; label: string; whatsapp: boolean }[];
}
export interface SampleAddress {
  id: string;
  kind: 'bill_to' | 'ship_to';
  label: string;
  address: string;
  isDefault: boolean;
}
export interface SampleParty {
  id: string;
  type: PartyType;
  name: string;
  gstin: string | null;
  city: string;
  defaultCommissionPerMt: number | null;
  paymentTermsText: string;
  isSelfTransporter: boolean;
  contacts: SampleContact[];
  addresses: SampleAddress[];
}
export interface SampleProduct {
  id: string;
  category: string;
  grade: string;
  sizeLabel: string;
  conversionPerMt: number;
  standardLengths: Length[];
  /** Company codes (AIP, VSL, KRM, NAP) that make it. */
  companyCodes: string[];
}

let contactN = 0;
let numberN = 0;
const contact = (name: string, roleLabel: string, numbers: [string, string, boolean][]): SampleContact => ({
  id: sid(6, ++contactN),
  name,
  roleLabel,
  numbers: numbers.map(([number, label, whatsapp]) => ({ id: sid(8, ++numberN), number, label, whatsapp })),
});
const addr = (
  id: string,
  kind: SampleAddress['kind'],
  label: string,
  address: string,
  isDefault: boolean,
): SampleAddress => ({ id, kind, label, address, isDefault });

const p = ids.parties;
const a = ids.addresses;
const base = { paymentTermsText: '', isSelfTransporter: false, defaultCommissionPerMt: null };

const parties: SampleParty[] = [
  {
    ...base,
    id: p.shubham,
    type: 'customer',
    name: 'Shubham Traders',
    gstin: '27AAKFS1234L1Z5',
    city: 'Nagpur',
    contacts: [
      contact('Suresh Jain', 'Owner', [
        ['+919826012345', 'Mobile', true],
        ['+917122551234', 'Office', false],
      ]),
      contact('Amit Verma', 'Accounts', [['+919425067890', 'Mobile', true]]),
    ],
    addresses: [
      addr(a.shubhamBill, 'bill_to', 'Bill to', 'Plot 14, Wardhaman Nagar, Nagpur 440008', true),
      addr(a.shubhamHingna, 'ship_to', 'Hingna MIDC site', 'Gate 3, Hingna Road, Nagpur 440016', true),
      addr(a.shubhamButibori, 'ship_to', 'Butibori yard', 'Plot B-22, Butibori, Nagpur 441122', false),
      addr(a.shubhamKamptee, 'ship_to', 'Kamptee Road godown', 'Near Indora Chowk, Nagpur 440017', false),
    ],
  },
  {
    ...base,
    id: p.patel,
    type: 'customer',
    name: 'Patel Infra Projects',
    gstin: null,
    city: 'Indore',
    contacts: [contact('Hitesh Patel', 'Purchase', [['+919893012211', 'Mobile', true]])],
    addresses: [
      addr(a.patelBill, 'bill_to', 'Bill to', '201, Shalimar Corporate, AB Road, Indore 452010', true),
      addr(a.patelSite2, 'ship_to', 'Site 2', 'Dewas Naka, Indore 452010', true),
    ],
  },
  {
    ...base,
    id: p.krishna,
    type: 'customer',
    name: 'Krishna Construction',
    gstin: null,
    city: 'Bhilai',
    contacts: [contact('Ramesh Sahu', 'Owner', [['+919827055410', 'Mobile', true]])],
    addresses: [
      addr(a.krishnaBill, 'bill_to', 'Bill to', 'Sector 6, Bhilai 490006', true),
      addr(a.krishnaSite, 'ship_to', 'Supela site', 'Supela Chowk, Bhilai 490023', true),
    ],
  },
  {
    ...base,
    id: p.gupta,
    type: 'customer',
    name: 'Gupta Hardware',
    gstin: null,
    city: 'Durg',
    contacts: [contact('Manish Gupta', 'Owner', [['+919826633001', 'Mobile', true]])],
    addresses: [
      addr(a.guptaBill, 'bill_to', 'Bill to', 'Station Road, Durg 491001', true),
      addr(a.guptaShop, 'ship_to', 'Shop', 'Station Road, Durg 491001', true),
    ],
  },
  {
    ...base,
    id: p.rkAgarwal,
    type: 'broker',
    name: 'R.K. Agarwal',
    gstin: null,
    city: 'Raipur',
    defaultCommissionPerMt: 150,
    contacts: [contact('R.K. Agarwal', 'Owner', [['+919826100501', 'Mobile', true]])],
    addresses: [],
  },
  {
    ...base,
    id: p.mittal,
    type: 'broker',
    name: 'Mittal Brokers',
    gstin: null,
    city: 'Raipur',
    defaultCommissionPerMt: 120,
    contacts: [contact('Sunil Mittal', 'Owner', [['+919826100502', 'Mobile', true]])],
    addresses: [],
  },
  {
    ...base,
    id: p.shreeGanesh,
    type: 'transporter',
    name: 'Shree Ganesh Roadlines',
    gstin: '22AEXPG5521K1Z9',
    city: 'Raipur',
    contacts: [
      contact('Manoj Sahu', 'Owner', [['+919893044120', 'Mobile', true]]),
      contact('Booking desk', 'Office', [['+917714008812', 'Office', false]]),
    ],
    addresses: [],
  },
  {
    ...base,
    id: p.golden,
    type: 'transporter',
    name: 'Golden Transport',
    gstin: null,
    city: 'Raipur',
    contacts: [contact('Imran Khan', 'Owner', [['+919826477102', 'Mobile', true]])],
    addresses: [],
  },
];

const tmt = (id: string, mm: number, conversionPerMt: number, lengths: number[]): SampleProduct => ({
  id,
  category: 'TMT',
  grade: 'Fe500D',
  sizeLabel: `${mm} mm`,
  conversionPerMt,
  standardLengths: lengths.map((value) => ({ value, unit: 'm' })),
  companyCodes: ['AIP', 'KRM'],
});
const pr = ids.products;

const products: SampleProduct[] = [
  tmt(pr.tmt8, 8, 2_200, [12]),
  tmt(pr.tmt10, 10, 1_800, [12]),
  tmt(pr.tmt12, 12, 1_500, [6, 12]),
  tmt(pr.tmt16, 16, 1_000, [12]),
  tmt(pr.tmt20, 20, 800, [12]),
  tmt(pr.tmt25, 25, 600, [6, 12]),
  {
    id: pr.billet,
    category: 'MS Billet',
    grade: '',
    sizeLabel: '100 × 100',
    conversionPerMt: 0,
    standardLengths: [{ value: 6, unit: 'm' }],
    companyCodes: ['AIP', 'NAP', 'VSL'],
  },
  {
    id: pr.ingot,
    category: 'MS Ingot',
    grade: '',
    sizeLabel: '4 inch',
    conversionPerMt: 0,
    standardLengths: [],
    companyCodes: ['NAP'],
  },
  {
    id: pr.angle,
    category: 'Angle',
    grade: '',
    sizeLabel: '50 × 50 × 5',
    conversionPerMt: 2_800,
    standardLengths: [{ value: 6, unit: 'm' }],
    companyCodes: ['VSL'],
  },
  {
    id: pr.channel,
    category: 'Channel',
    grade: '',
    sizeLabel: '75 × 40',
    conversionPerMt: 3_100,
    standardLengths: [
      { value: 6, unit: 'm' },
      { value: 12, unit: 'm' },
    ],
    companyCodes: ['VSL'],
  },
];

export const SAMPLE_MASTERS = { ids, parties, products } as const;
