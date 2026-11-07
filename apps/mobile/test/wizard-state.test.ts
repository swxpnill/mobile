import { type Order, type Product, SAMPLE_MASTERS, SAMPLE_WORLD, createOrderBodySchema } from '@tonnage/shared';
import {
  type WizardState,
  emptyWizard,
  fromOrder,
  fromPayload,
  newLine,
  partiesProblem,
  preview,
  toCreateBody,
  toPayload,
  toUpdateBody,
} from '../src/screens/new-order/wizard';

const C = SAMPLE_WORLD.ids.companies;
const P = SAMPLE_MASTERS.ids.parties;
const PR = SAMPLE_MASTERS.ids.products;
const A = SAMPLE_MASTERS.ids.addresses;

const product = (id: string, conversionPerMt: number): Product =>
  ({ id, conversionPerMt, displayName: '', category: 'TMT', grade: '', sizeLabel: '', tag: 'TMT', standardLengths: [], companyIds: [], active: true, version: 1 }) as Product;
const products = new Map([
  [PR.tmt12, product(PR.tmt12, 1_500)],
  [PR.tmt16, product(PR.tmt16, 1_000)],
]);

/** The canvas order as someone types it into the wizard (MT basis). */
function canvas(): WizardState {
  const s = emptyWizard('basic_conversion');
  return {
    ...s,
    type: 'customer_broker',
    customerId: P.shubham,
    brokerId: P.rkAgarwal,
    commission: '150',
    billToId: A.shubhamBill,
    shipToId: A.shubhamHingna,
    basicRate: '44500',
    subOrders: [
      {
        companyId: C.AIP,
        lines: [
          { ...newLine(PR.tmt12), length: { value: 12, unit: 'm' }, qty: '24', overprice: '300' },
          { ...newLine(PR.tmt12), length: { value: 6, unit: 'm' }, qty: '10' },
          { ...newLine(PR.tmt16), length: { value: 12, unit: 'm' }, qty: '20', overprice: '300' },
        ],
      },
      { companyId: C.KRM, lines: [{ ...newLine(PR.tmt16), length: { value: 40, unit: 'ft' }, qty: '30', rate: '45600', overprice: '300' }] },
    ],
  };
}

describe('wizard state', () => {
  it('the canvas order becomes exactly the create body the API expects', () => {
    const r = toCreateBody(canvas(), 'mt', null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(createOrderBodySchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({
      type: 'customer_broker',
      commissionPerMt: 150,
      basicRate: 44_500,
      subOrders: [
        { companyId: C.AIP, lines: [{ orderedKg: 24_000, typedRate: null, overpricePerMt: 300 }, { orderedKg: 10_000, overpricePerMt: 0 }, { orderedKg: 20_000 }] },
        { companyId: C.KRM, lines: [{ orderedKg: 30_000, typedRate: 45_600 }] },
      ],
    });
  });

  it('a kg user types rates per kg: 46.3 → ₹46,300 per MT; 24,000 kg stays 24,000', () => {
    const s = canvas();
    s.basicRate = '44.5';
    s.commission = '0.15';
    s.subOrders[0]!.lines[0]!.qty = '24,000';
    s.subOrders[0]!.lines[0]!.rate = '46.3';
    s.subOrders[0]!.lines[0]!.overprice = '0.3';
    s.subOrders[0]!.lines[1]!.qty = '10000';
    s.subOrders[0]!.lines[2]!.qty = '20000';
    s.subOrders[1]!.lines[0]!.qty = '30000';
    s.subOrders[1]!.lines[0]!.rate = '45.6';
    s.subOrders[1]!.lines[0]!.overprice = '0.3';
    const r = toCreateBody(s, 'kg', null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatchObject({ basicRate: 44_500, commissionPerMt: 150 });
    expect(r.body.subOrders[0]!.lines[0]).toMatchObject({ orderedKg: 24_000, typedRate: 46_300, overpricePerMt: 300 });
    expect(r.body.subOrders[1]!.lines[0]).toMatchObject({ orderedKg: 30_000, typedRate: 45_600 });
  });

  it('preview matches the server: ₹38,64,200, broker estimate ₹34,800, per company', () => {
    const p = preview(canvas(), 'mt', products);
    expect(p.totalKg).toBe(84_000);
    expect(p.totalValue).toBe(3_864_200);
    expect(p.perSub.map((x) => [x.kg, x.value])).toEqual([
      [54_000, 2_487_200],
      [30_000, 1_377_000],
    ]);
    expect(p.broker).toMatchObject({ commission: 12_600, overprice: 22_200, total: 34_800 });
    expect(p.lines[0]).toMatchObject({ rate: 46_000, value: 1_111_200 });
  });

  it('each mistake points at its field: missing qty, too many decimals, direct line without a rate', () => {
    const s = canvas();
    s.subOrders[0]!.lines[1]!.qty = '';
    s.subOrders[0]!.lines[2]!.qty = '1.2345';
    s.pricingMethod = 'direct';
    const r = toCreateBody(s, 'mt', null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors['subOrders.0.lines.1.qty']).toBe('Enter the quantity');
    expect(r.errors['subOrders.0.lines.2.qty']).toBe('Up to 3 decimals');
    expect(r.errors['subOrders.0.lines.0.rate']).toBe('Enter the rate');
  });

  it('parties step: what is missing, by order type', () => {
    const s = emptyWizard('basic_conversion');
    expect(partiesProblem({ ...s, type: 'customer' })).toBe('Choose the customer');
    expect(partiesProblem({ ...s, type: 'broker_only' })).toBe('Choose the broker');
    expect(partiesProblem(canvas())).toBeNull();
    expect(partiesProblem({ ...canvas(), commission: '' })).toBe('Enter the broker commission');
  });

  it('drafts round-trip through the payload; a foreign payload is refused', () => {
    const s = canvas();
    expect(fromPayload(toPayload(s))).toEqual(s);
    expect(fromPayload({ hello: 1 })).toBeNull();
  });

  it('an existing order opens in edit mode and saves unchanged with every id and version', () => {
    const order = {
      id: 'o1',
      version: 4,
      type: 'customer',
      customer: { id: P.patel, name: 'Patel', city: 'Indore' },
      broker: null,
      commissionPerMtSnapshot: null,
      billTo: { id: A.patelBill, label: 'Bill to', address: '' },
      shipTo: { id: A.patelSite2, label: 'Site 2', address: '' },
      pricingMethod: 'direct',
      basicRate: null,
      notify: { customer: true, broker: false },
      subOrders: [
        {
          id: 's1',
          companyId: C.KRM,
          version: 2,
          lines: [{ id: 'l1', productId: PR.tmt16, length: { value: 12, unit: 'm' }, orderedKg: 40_000, rate: 46_500, rateEdited: false, overpricePerMt: 0, version: 3 }],
        },
      ],
    } as unknown as Order;
    const s = fromOrder(order, 'mt');
    expect(s).toMatchObject({ mode: 'edit', orderId: 'o1', orderVersion: 4, step: 2 });
    const r = toUpdateBody(s, 'mt');
    expect(r.ok && r.body).toEqual({
      version: 4,
      type: 'customer',
      customerId: P.patel,
      brokerId: null,
      commissionPerMt: null,
      billToId: A.patelBill,
      shipToId: A.patelSite2,
      pricingMethod: 'direct',
      basicRate: null,
      notify: { customer: true, broker: false },
      subOrders: [
        {
          id: 's1',
          companyId: C.KRM,
          lines: [{ id: 'l1', productId: PR.tmt16, length: { value: 12, unit: 'm' }, orderedKg: 40_000, typedRate: 46_500, overpricePerMt: 0 }],
        },
      ],
    });
  });
});
