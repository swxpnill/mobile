import { SAMPLE_WORLD } from '@tonnage/shared';
import type { Party, Product } from '@tonnage/shared';
import type { Side } from './parity.ts';

export const COMPANY = SAMPLE_WORLD.ids.companies;

/** The masters an order test books against, by name; ids differ per side. */
export interface Masters {
  shubham: Party;
  patel: Party;
  broker: Party;
  transporter: Party;
  tmt12: Product;
  tmt16: Product;
  billet: Product;
}

const contact = (name: string, number: string) => ({
  name,
  roleLabel: 'Owner',
  numbers: [{ number, label: 'Mobile', whatsapp: true }],
});

const customer = (name: string, city: string, sites: string[]) => ({
  type: 'customer',
  name,
  gstin: null,
  city,
  defaultCommissionPerMt: null,
  paymentTermsText: '30 days',
  isSelfTransporter: false,
  contacts: [contact(`${name} Owner`, '98260 12345')],
  addresses: [
    { kind: 'bill_to', label: 'Bill to', address: `Head office, ${city}`, isDefault: true },
    ...sites.map((label, i) => ({ kind: 'ship_to', label, address: `${label}, ${city}`, isDefault: i === 0 })),
  ],
});

const product = (category: string, grade: string, sizeLabel: string, companyIds: string[]) => ({
  category,
  grade,
  sizeLabel,
  conversionPerMt: grade === '' ? 0 : 1_500,
  standardLengths: [{ value: 12, unit: 'm' }],
  companyIds,
});

/**
 * Creates the same masters through one side's API (R3: tests make their own; the GSTINs are null
 * and the product names differ from the mock's built-in SAMPLE_MASTERS, so both sides accept them).
 */
export async function createMasters(side: Side): Promise<Masters> {
  const post = async <T>(path: string, body: object): Promise<T> => {
    const res = await side.call('POST', path, { body });
    if (res.status !== 201) throw new Error(`${side.name} POST ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  };
  const party = (body: object) => post<Party>('/v1/parties', body);
  const prod = (body: object) => post<Product>('/v1/products', body);
  return {
    shubham: await party(customer('Shubham Test Traders', 'Nagpur', ['Hingna MIDC site', 'Butibori yard'])),
    patel: await party(customer('Patel Test Steel', 'Raipur', ['Urla yard'])),
    broker: await party({
      type: 'broker',
      name: 'Test Agarwal Brokers',
      gstin: null,
      city: 'Raipur',
      defaultCommissionPerMt: 150,
      paymentTermsText: '',
      isSelfTransporter: false,
      contacts: [contact('Test Agarwal', '98271 55012')],
      addresses: [],
    }),
    transporter: await party({
      type: 'transporter',
      name: 'Test Roadways',
      gstin: null,
      city: 'Raipur',
      defaultCommissionPerMt: null,
      paymentTermsText: '',
      isSelfTransporter: false,
      contacts: [contact('Test Roadways desk', '98271 55013')],
      addresses: [],
    }),
    tmt12: await prod(product('TMT', 'Fe550D', '12 mm', [COMPANY.AIP, COMPANY.KRM])),
    tmt16: await prod(product('TMT', 'Fe550D', '16 mm', [COMPANY.AIP, COMPANY.KRM])),
    billet: await prod(product('MS Billet', '', '125 × 125', [COMPANY.NAP])),
  };
}

const addressId = (p: Party, label: string) => {
  const a = p.addresses.find((x) => x.label === label);
  if (!a) throw new Error(`${p.name} has no address ${label}`);
  return a.id;
};

const line = (productId: string, o: Record<string, unknown> = {}) => ({
  productId,
  length: { value: 12, unit: 'm' },
  orderedKg: 24_000,
  typedRate: null,
  overpricePerMt: 300,
  ...o,
});

/** The contract's canvas order on these masters: AIP 3 lines + KRM 1 line (a rate override). */
export const canvasOrder = (m: Masters) => ({
  draftId: null,
  type: 'customer_broker',
  customerId: m.shubham.id,
  brokerId: m.broker.id,
  commissionPerMt: 150,
  billToId: addressId(m.shubham, 'Bill to'),
  shipToId: addressId(m.shubham, 'Hingna MIDC site'),
  pricingMethod: 'basic_conversion',
  basicRate: 44_500,
  subOrders: [
    {
      companyId: COMPANY.AIP,
      lines: [
        line(m.tmt12.id),
        line(m.tmt12.id, { length: { value: 6, unit: 'm' }, orderedKg: 10_000, overpricePerMt: 0 }),
        line(m.tmt16.id, { orderedKg: 20_000 }),
      ],
    },
    {
      companyId: COMPANY.KRM,
      lines: [line(m.tmt16.id, { length: { value: 40, unit: 'ft' }, orderedKg: 30_000, typedRate: 45_600 })],
    },
  ],
  notify: { customer: true, broker: true },
});

/** A direct-priced customer order on KRM only. */
export const krmOrder = (m: Masters) => ({
  draftId: null,
  type: 'customer',
  customerId: m.patel.id,
  brokerId: null,
  commissionPerMt: null,
  billToId: addressId(m.patel, 'Bill to'),
  shipToId: addressId(m.patel, 'Urla yard'),
  pricingMethod: 'direct',
  basicRate: null,
  subOrders: [{ companyId: COMPANY.KRM, lines: [line(m.tmt12.id, { typedRate: 46_000, overpricePerMt: 0 })] }],
  notify: { customer: true, broker: false },
});

/** A broker-only order on NAP (billets, no length in mm). */
export const napBrokerOrder = (m: Masters) => ({
  draftId: null,
  type: 'broker_only',
  customerId: null,
  brokerId: m.broker.id,
  commissionPerMt: 120,
  billToId: null,
  shipToId: null,
  pricingMethod: 'direct',
  basicRate: null,
  subOrders: [{ companyId: COMPANY.NAP, lines: [line(m.billet.id, { orderedKg: 45_500, typedRate: 41_000, overpricePerMt: 150 })] }],
  notify: { customer: false, broker: true },
});

export { addressId };
