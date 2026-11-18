import { describe, expect, it } from 'vitest';
import {
  assignTruckBodySchema,
  cancelTruckBodySchema,
  driverPhoneSchema,
  syncBodySchema,
  syncEventSchema,
  vehicleNoSchema,
} from './trucks.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = {
  vehicleNo: 'CG04MK2291',
  transporterId: null,
  driverName: 'Ramu',
  driverPhone: '98261 00012',
  lrNo: null,
  plan: [{ orderLineId: id(1), plannedKg: 10000 }],
};
const ev = { eventId: id(1), truckId: id(2), deviceSeq: 0, capturedAtDevice: '2026-11-13T10:00:00.000Z' };

describe('trucks schemas', () => {
  it('vehicleNo is trimmed, upper-cased, single-spaced', () => {
    expect(vehicleNoSchema.parse(' cg04mk  2291 ')).toBe('CG04MK 2291');
    expect(vehicleNoSchema.safeParse('ab').success).toBe(false);
    expect(vehicleNoSchema.safeParse('CG-04').success).toBe(false);
  });
  it('driverPhone normalises', () => {
    expect(driverPhoneSchema.parse('98261 00012')).toBe('+919826100012');
  });
  it('assign body refuses duplicate order lines and empty plan', () => {
    expect(assignTruckBodySchema.safeParse(base).success).toBe(true);
    const dup = { ...base, plan: [base.plan[0], { orderLineId: id(1), plannedKg: 5 }] };
    expect(assignTruckBodySchema.safeParse(dup).success).toBe(false);
    expect(assignTruckBodySchema.safeParse({ ...base, plan: [] }).success).toBe(false);
  });
  it('cancel body needs a known reason', () => {
    expect(cancelTruckBodySchema.safeParse({ reason: 'nope', note: '', version: 1 }).success).toBe(false);
  });
  it('sync body refuses 101 events', () => {
    const e = { ...ev, type: 'AT_GATE' };
    const mk = (n: number) => ({ deviceId: 'device-0001', events: Array.from({ length: n }, () => e) });
    expect(syncBodySchema.safeParse(mk(100)).success).toBe(true);
    expect(syncBodySchema.safeParse(mk(101)).success).toBe(false);
  });
  it('GROSS without allocations is refused', () => {
    expect(syncEventSchema.safeParse({ ...ev, type: 'GROSS', grossKg: 30000 }).success).toBe(false);
    expect(
      syncEventSchema.safeParse({ ...ev, type: 'GROSS', grossKg: 30000, allocations: [{ orderLineId: id(1), netKg: 10 }] })
        .success,
    ).toBe(true);
    expect(syncEventSchema.safeParse({ ...ev, type: 'TARE', tareKg: 0 }).success).toBe(false);
  });
});
