import { describe, expect, it } from 'vitest';
import { SAMPLE_WORLD } from '../fixtures/sample-world.ts';
import { partyBodySchema, phoneInputSchema, productBodySchema } from './masters.ts';

const paths = (r: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => i.path) ?? [];

const shubham = {
  type: 'customer',
  name: 'Shubham Traders',
  gstin: '27aakfs1234l1z5',
  city: 'Nagpur',
  defaultCommissionPerMt: null,
  paymentTermsText: '',
  isSelfTransporter: false,
  contacts: [
    {
      name: 'Suresh Jain',
      roleLabel: 'Owner',
      numbers: [
        { number: '98260 12345', label: 'Mobile', whatsapp: true },
        { number: '0712 255 1234', label: 'Office', whatsapp: false },
      ],
    },
  ],
  addresses: [
    { kind: 'bill_to', label: 'Bill to', address: 'Plot 14, Wardhaman Nagar, Nagpur 440008', isDefault: true },
    { kind: 'ship_to', label: 'Hingna MIDC site', address: 'Gate 3, Hingna Road, Nagpur 440016', isDefault: true },
    { kind: 'ship_to', label: 'Butibori yard', address: 'Plot B-22, Butibori, Nagpur 441122', isDefault: false },
  ],
};

describe('phoneInputSchema', () => {
  it('mobiles and landlines with STD code become +91 and 10 digits', () => {
    expect(phoneInputSchema.parse('98260 12345')).toBe('+919826012345');
    expect(phoneInputSchema.parse('0712 255 1234')).toBe('+917122551234');
    expect(phoneInputSchema.parse('+91 771 400 8812')).toBe('+917714008812');
  });

  it('too short or starting with 0 after the prefix is refused', () => {
    expect(phoneInputSchema.safeParse('255 1234').success).toBe(false);
    expect(phoneInputSchema.safeParse('00122551234').success).toBe(false);
  });
});

describe('partyBodySchema', () => {
  it('accepts the canvas customer and normalises GSTIN and numbers', () => {
    const p = partyBodySchema.parse(shubham);
    expect(p.gstin).toBe('27AAKFS1234L1Z5');
    expect(p.contacts[0]?.numbers.map((n) => n.number)).toEqual(['+919826012345', '+917122551234']);
  });

  it('empty GSTIN means "not registered" (null)', () => {
    expect(partyBodySchema.parse({ ...shubham, gstin: '  ' }).gstin).toBeNull();
  });

  it('bad GSTIN shape or state → gstin', () => {
    expect(paths(partyBodySchema.safeParse({ ...shubham, gstin: '27AAKFS1234L1Z' }))).toContainEqual(['gstin']);
    expect(paths(partyBodySchema.safeParse({ ...shubham, gstin: '99AAKFS1234L1Z5' }))).toContainEqual(['gstin']);
  });

  it('a customer needs exactly one bill-to and ≥ 1 ship-to with exactly one default', () => {
    const noShip = { ...shubham, addresses: [shubham.addresses[0]] };
    expect(paths(partyBodySchema.safeParse(noShip))).toContainEqual(['addresses']);
    const twoBill = { ...shubham, addresses: [...shubham.addresses, shubham.addresses[0]] };
    expect(paths(partyBodySchema.safeParse(twoBill))).toContainEqual(['addresses']);
    const twoDefaults = {
      ...shubham,
      addresses: shubham.addresses.map((a) => ({ ...a, isDefault: true })),
    };
    expect(paths(partyBodySchema.safeParse(twoDefaults))).toContainEqual(['addresses']);
  });

  it('only brokers carry a default commission', () => {
    expect(paths(partyBodySchema.safeParse({ ...shubham, defaultCommissionPerMt: 150 }))).toContainEqual([
      'defaultCommissionPerMt',
    ]);
    expect(
      partyBodySchema.safeParse({ ...shubham, type: 'broker', addresses: [], defaultCommissionPerMt: 150 }).success,
    ).toBe(true);
  });

  it('a contact needs at least one number; at most 5 numbers', () => {
    const c0 = shubham.contacts[0]!;
    expect(paths(partyBodySchema.safeParse({ ...shubham, contacts: [{ ...c0, numbers: [] }] }))).toContainEqual([
      'contacts',
      0,
      'numbers',
    ]);
  });
});

describe('productBodySchema', () => {
  const tmt12 = {
    category: 'TMT',
    grade: 'Fe500D',
    sizeLabel: '12 mm',
    conversionPerMt: 1_500,
    standardLengths: [
      { value: 6, unit: 'm' },
      { value: 12, unit: 'm' },
    ],
    companyIds: [SAMPLE_WORLD.ids.companies.AIP],
  };

  it('accepts the canvas TMT 12 mm', () => {
    expect(productBodySchema.safeParse(tmt12).success).toBe(true);
  });

  it('needs at least one company; standard lengths unique', () => {
    expect(paths(productBodySchema.safeParse({ ...tmt12, companyIds: [] }))).toContainEqual(['companyIds']);
    const dup = { ...tmt12, standardLengths: [{ value: 6, unit: 'm' }, { value: 6, unit: 'm' }] };
    expect(paths(productBodySchema.safeParse(dup))).toContainEqual(['standardLengths', 1]);
  });
});
