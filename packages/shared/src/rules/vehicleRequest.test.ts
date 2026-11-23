import { describe, expect, it } from 'vitest';
import { MONEY_KEYS } from '../redact.ts';
import { vehicleRequestSchema, vehicleRequestBodySchema, orderSchema } from '../schemas/orders.ts';
import type { Party } from '../schemas/masters.ts';
import {
  buildRequestMessage,
  clampLineKg,
  defaultRecipient,
  isRequestOpen,
  isWhatsAppNumber,
  type RequestMessageInput,
} from './vehicleRequest.ts';

const BROKER = 'party-broker';
const CUSTOMER = 'party-customer';
const RK = 'contact-rk';
const RK_WA = 'num-rk-wa';
const SO_A = 'so-a';
const BEFORE = '2026-11-23T05:00:00.000Z';
const REQUESTED = '2026-11-23T06:00:00.000Z';
const AFTER = '2026-11-23T07:00:00.000Z';

const num = (id: string, number: string, whatsapp: boolean) => ({ id, number, label: '', whatsapp });
const party = (id: string, numbers: ReturnType<typeof num>[]): Party =>
  ({
    id,
    contacts: numbers.length
      ? [{ id: id === BROKER ? RK : `contact-${id}`, name: 'X', roleLabel: '', numbers }]
      : [],
  }) as unknown as Party;

const parties: Record<string, Party> = {
  [BROKER]: party(BROKER, [num('num-rk-land', '+911123456789', false), num(RK_WA, '+919826012345', true)]),
  [CUSTOMER]: party(CUSTOMER, [num('num-c-wa', '+919826099999', true)]),
  'broker-land': party('broker-land', [num('l1', '+911123456789', true)]),
  'broker-none': party('broker-none', []),
};
const ref = (id: string) => ({ id, name: id, city: '' });

describe('defaultRecipient', () => {
  it('prefers the broker WhatsApp number', () => {
    expect(defaultRecipient({ broker: ref(BROKER), customer: ref(CUSTOMER) }, parties)).toEqual({
      partyId: BROKER,
      contactId: RK,
      numberId: RK_WA,
    });
  });
  it('falls to the customer when the broker has only a landline', () => {
    expect(defaultRecipient({ broker: ref('broker-land'), customer: ref(CUSTOMER) }, parties)?.partyId).toBe(CUSTOMER);
  });
  it('uses the customer on a customer-only order', () => {
    expect(defaultRecipient({ broker: null, customer: ref(CUSTOMER) }, parties)?.partyId).toBe(CUSTOMER);
  });
  it('uses the broker landline when nobody has WhatsApp', () => {
    expect(defaultRecipient({ broker: ref('broker-land'), customer: null }, parties)?.partyId).toBe('broker-land');
  });
  it('is null with no numbers', () => {
    expect(defaultRecipient({ broker: ref('broker-none'), customer: null }, parties)).toBeNull();
  });
});

describe('isWhatsAppNumber', () => {
  it('refuses a landline even when flagged', () => {
    expect(isWhatsAppNumber({ number: '+911123456789', whatsapp: true })).toBe(false);
  });
  it('accepts a flagged mobile and refuses an unflagged one', () => {
    expect(isWhatsAppNumber({ number: '+919826012345', whatsapp: true })).toBe(true);
    expect(isWhatsAppNumber({ number: '+919826012345', whatsapp: false })).toBe(false);
  });
});

describe('clampLineKg', () => {
  it('keeps the value in [0, pending] as an integer', () => {
    expect([clampLineKg(30_001, 30_000), clampLineKg(-5, 30_000), clampLineKg(12_500, 30_000)]).toEqual([
      30_000, 0, 12_500,
    ]);
    expect(clampLineKg(12.7, 30_000)).toBe(12);
    expect(clampLineKg(Number.NaN, 30_000)).toBe(0);
  });
});

const canvasExample: RequestMessageInput = {
  contactFirstName: 'R.K.',
  orderNo: 'SO-2611-0142',
  party: 'Shubham Traders, Nagpur',
  lines: [
    { product: 'TMT Fe500D', size: '12 mm', length: '12 m', kg: 24_000, company: 'Aarav', plant: 'Siltara' },
    { product: 'TMT Fe500D', size: '16 mm', length: '12 m', kg: 30_000, company: 'Kalinga', plant: 'Borai' },
  ],
  senderFirstName: 'Rajesh',
  basis: 'mt',
};

describe('buildRequestMessage', () => {
  it('matches the canvas template', () => {
    expect(buildRequestMessage(canvasExample)).toBe(
      'Namaste R.K. ji, please arrange a vehicle for order SO-2611-0142 (Shubham Traders, Nagpur):\n' +
        '• TMT Fe500D 12 mm · 12 m — 24.000 MT (Aarav, Siltara)\n' +
        '• TMT Fe500D 16 mm · 12 m — 30.000 MT (Kalinga, Borai)\n' +
        'Total 54.000 MT. Please share vehicle number and driver phone.\n– Rajesh, Tonnage',
    );
  });
  it('uses kg when asked', () => {
    const m = buildRequestMessage({ ...canvasExample, basis: 'kg' });
    expect(m).toContain('24,000 kg');
    expect(m).toContain('Total 54,000 kg.');
  });
  it('drops the plant when there is none', () => {
    const m = buildRequestMessage({
      ...canvasExample,
      lines: [{ ...canvasExample.lines[0]!, plant: null }],
    });
    expect(m).toContain('(Aarav)\n');
  });
});

describe('isRequestOpen', () => {
  const req = {
    requestedAt: REQUESTED,
    lines: [{ orderLineId: 'l1', subOrderId: SO_A, kg: 10_000 }],
  };
  const ctx = { subOrderClosed: () => false, linePendingKg: () => 10_000 };
  it('closes when a truck is assigned to its sub-order after the request', () => {
    expect(isRequestOpen(req, { trucks: [{ subOrderIds: [SO_A], assignedAt: AFTER }], ...ctx })).toBe(false);
  });
  it('stays open for a truck assigned before the request or to another sub-order', () => {
    expect(isRequestOpen(req, { trucks: [{ subOrderIds: [SO_A], assignedAt: BEFORE }], ...ctx })).toBe(true);
    expect(isRequestOpen(req, { trucks: [{ subOrderIds: ['other'], assignedAt: AFTER }], ...ctx })).toBe(true);
  });
  it('closes on a short close or when nothing is pending', () => {
    expect(isRequestOpen(req, { trucks: [], ...ctx, subOrderClosed: () => true })).toBe(false);
    expect(isRequestOpen(req, { trucks: [], ...ctx, linePendingKg: () => 0 })).toBe(false);
  });
});

describe('vehicle request schemas', () => {
  it('has no money keys', () => {
    const keys = [
      ...Object.keys(vehicleRequestSchema.shape),
      ...Object.keys(vehicleRequestSchema.shape.lines.element.shape),
    ];
    expect(keys.filter((k) => MONEY_KEYS.has(k))).toEqual([]);
    expect(Object.keys(orderSchema.shape)).toContain('vehicleRequests');
  });
  it('body needs 1 to 50 positive integer lines and rejects extras', () => {
    const ok = {
      partyId: '11111111-1111-4111-8111-111111111111',
      contactName: 'R.K.',
      number: '+919826012345',
      channel: 'call',
      lines: [{ orderLineId: '22222222-2222-4222-8222-222222222222', kg: 1000 }],
      totalKg: 1000,
    };
    expect(vehicleRequestBodySchema.safeParse(ok).success).toBe(true);
    expect(vehicleRequestBodySchema.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(vehicleRequestBodySchema.safeParse({ ...ok, lines: [{ orderLineId: '22222222-2222-4222-8222-222222222222', kg: 1.5 }] }).success).toBe(false);
    expect(vehicleRequestBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
