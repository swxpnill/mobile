import { describe, expect, it } from 'vitest';
import { SAMPLE_WORLD } from '../fixtures/sample-world.ts';
import { redactForRole } from '../redact.ts';
import {
  createOrderBodySchema,
  orderListQuerySchema,
  orderSummarySchema,
  shortCloseBodySchema,
  updateOrderBodySchema,
} from './orders.ts';

const c = SAMPLE_WORLD.ids.companies;
const id = (n: number) => `019a4c00-0009-7000-8000-${String(n).padStart(12, '0')}`;
const line = (o: Record<string, unknown> = {}) => ({
  productId: id(1),
  length: { value: 12, unit: 'm' },
  orderedKg: 24_000,
  typedRate: null,
  overpricePerMt: 300,
  ...o,
});

/** The canvas order: Shubham Traders via R.K. Agarwal, AIP 3 lines + KRM 1 line. */
export const canvasOrder = {
  draftId: null,
  type: 'customer_broker',
  customerId: id(10),
  brokerId: id(11),
  commissionPerMt: 150,
  billToId: id(20),
  shipToId: id(21),
  pricingMethod: 'basic_conversion',
  basicRate: 44_500,
  subOrders: [
    {
      companyId: c.AIP,
      lines: [
        line(),
        line({ length: { value: 6, unit: 'm' }, orderedKg: 10_000, overpricePerMt: 0 }),
        line({ productId: id(2), orderedKg: 20_000 }),
      ],
    },
    {
      companyId: c.KRM,
      lines: [line({ productId: id(2), length: { value: 40, unit: 'ft' }, orderedKg: 30_000, typedRate: 45_600 })],
    },
  ],
  notify: { customer: true, broker: true },
};

const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => i.path) ?? [];

describe('createOrderBodySchema', () => {
  it('accepts the canvas order', () => {
    expect(createOrderBodySchema.safeParse(canvasOrder).success).toBe(true);
  });

  it('customer + broker without a broker → brokerId', () => {
    const r = createOrderBodySchema.safeParse({ ...canvasOrder, brokerId: null });
    expect(paths(r)).toContainEqual(['brokerId']);
  });

  it('customer order without customer, bill-to or ship-to → each path', () => {
    const r = createOrderBodySchema.safeParse({
      ...canvasOrder,
      type: 'customer',
      brokerId: null,
      commissionPerMt: null,
      customerId: null,
      billToId: null,
      shipToId: null,
    });
    expect(paths(r)).toEqual(expect.arrayContaining([['customerId'], ['billToId'], ['shipToId']]));
  });

  it('broker only may leave the customer out; a customer order may not carry a commission', () => {
    expect(
      createOrderBodySchema.safeParse({
        ...canvasOrder,
        type: 'broker_only',
        customerId: null,
        billToId: null,
        shipToId: null,
      }).success,
    ).toBe(true);
    const r = createOrderBodySchema.safeParse({ ...canvasOrder, type: 'customer', brokerId: null });
    expect(paths(r)).toContainEqual(['commissionPerMt']);
  });

  it('direct pricing with a line missing its rate → that line', () => {
    const r = createOrderBodySchema.safeParse({ ...canvasOrder, pricingMethod: 'direct', basicRate: null });
    expect(paths(r)).toContainEqual(['subOrders', 0, 'lines', 1, 'typedRate']);
  });

  it('basic + conversion without a basic rate → basicRate', () => {
    expect(paths(createOrderBodySchema.safeParse({ ...canvasOrder, basicRate: null }))).toContainEqual([
      'basicRate',
    ]);
  });

  it('two sub-orders for one company → subOrders[1].companyId', () => {
    const r = createOrderBodySchema.safeParse({
      ...canvasOrder,
      subOrders: [canvasOrder.subOrders[0], { ...canvasOrder.subOrders[1], companyId: c.AIP }],
    });
    expect(paths(r)).toContainEqual(['subOrders', 1, 'companyId']);
  });

  it('length 101, 0 kg, fractional kg and negative overprice are refused', () => {
    const bad = (l: Record<string, unknown>) =>
      paths(
        createOrderBodySchema.safeParse({
          ...canvasOrder,
          subOrders: [{ companyId: c.AIP, lines: [line(l)] }],
        }),
      );
    expect(bad({ length: { value: 101, unit: 'm' } })).toContainEqual(['subOrders', 0, 'lines', 0, 'length', 'value']);
    expect(bad({ orderedKg: 0 })).toContainEqual(['subOrders', 0, 'lines', 0, 'orderedKg']);
    expect(bad({ orderedKg: 1.5 })).toContainEqual(['subOrders', 0, 'lines', 0, 'orderedKg']);
    expect(bad({ overpricePerMt: -1 })).toContainEqual(['subOrders', 0, 'lines', 0, 'overpricePerMt']);
  });

  it('an order needs at least one company and each company at least one line', () => {
    expect(paths(createOrderBodySchema.safeParse({ ...canvasOrder, subOrders: [] }))).toContainEqual(['subOrders']);
    expect(
      paths(createOrderBodySchema.safeParse({ ...canvasOrder, subOrders: [{ companyId: c.AIP, lines: [] }] })),
    ).toContainEqual(['subOrders', 0, 'lines']);
  });
});

describe('updateOrderBodySchema', () => {
  it('needs the order version; line ids and versions are optional (new lines)', () => {
    const rest: Record<string, unknown> = { ...canvasOrder };
    delete rest.draftId;
    expect(updateOrderBodySchema.safeParse(rest).success).toBe(false);
    expect(updateOrderBodySchema.safeParse({ ...rest, version: 3 }).success).toBe(true);
  });
});

describe('other bodies and queries', () => {
  it('short close: reason from the list, note ≤ 200', () => {
    expect(
      shortCloseBodySchema.safeParse({ reason: 'Rate changed', note: '', cancelOpenTrucks: false, version: 1 }).success,
    ).toBe(true);
    expect(
      shortCloseBodySchema.safeParse({ reason: 'Bored', note: '', cancelOpenTrucks: false, version: 1 }).success,
    ).toBe(false);
  });

  it('list query: defaults and string numbers from the URL', () => {
    expect(orderListQuerySchema.parse({})).toMatchObject({ status: 'all', sort: 'newest', limit: 20 });
    expect(orderListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(orderListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });
});

describe('orderSummarySchema', () => {
  it('parses a row a plant head receives (money keys removed)', () => {
    const row = {
      id: id(30),
      number: 'SO-2611-0141',
      status: 'partly_dispatched',
      type: 'customer',
      customerName: 'Patel Infra Projects',
      customerCity: 'Indore',
      brokerName: null,
      companyCodes: ['KRM'],
      productsLabel: 'TMT 16, 20, 25 mm',
      totals: { orderedKg: 120_000, dispatchedKg: 72_400, closedKg: 0, reservedKg: 0, pendingKg: 47_600, overKg: 0 },
      estimatedValue: 5_580_000,
      createdAt: '2026-11-05T03:45:00.000Z',
      ageDays: 1,
      isAged: false,
    };
    const redacted = redactForRole('plant_head', row);
    expect(redacted).not.toHaveProperty('estimatedValue');
    expect(orderSummarySchema.safeParse(redacted).success).toBe(true);
  });
});
