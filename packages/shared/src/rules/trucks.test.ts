import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CLOCK_SKEW_FLAG_MS,
  TRUCK_CANCEL_REASONS,
  checkAllocations,
  netKg,
  nextTruckState,
  overToleranceKg,
  plausibility,
  splitProRata,
  toleranceCloseKg,
  truckEarning,
} from './trucks.ts';

describe('truckEarning', () => {
  it('canvas earning: 24.180 MT × (₹150 + ₹300) = ₹10,881', () => {
    const lines = new Map([['l1', { overpricePerMt: 300 }]]);
    const r = truckEarning([{ orderLineId: 'l1', netKg: 24_180 }], lines, 150);
    expect(r.earningRupees).toBe(10_881);
    expect(r.breakdown).toEqual([{ orderLineId: 'l1', netKg: 24_180, perMt: 450 }]);
  });
  it('rounds once over all allocations', () => {
    const lines = new Map([
      ['a', { overpricePerMt: 0 }],
      ['b', { overpricePerMt: 0 }],
    ]);
    // 0.0004 MT each at ₹1/MT: 400 + 400 kg => 800/1000 = 0.8 -> 1 (per-row rounding would give 0)
    const r = truckEarning(
      [
        { orderLineId: 'a', netKg: 400 },
        { orderLineId: 'b', netKg: 400 },
      ],
      lines,
      1,
    );
    expect(r.earningRupees).toBe(1);
  });
  it('throws when a line is missing', () => {
    expect(() => truckEarning([{ orderLineId: 'x', netKg: 1 }], new Map(), 1)).toThrow();
  });
});

describe('splitProRata', () => {
  it('splits 24.180 MT over plans 16 + 8 MT exactly', () => {
    const a = splitProRata(24_180, [
      { orderLineId: 'a', plannedKg: 16_000 },
      { orderLineId: 'b', plannedKg: 8_000 },
    ]);
    expect(a).toEqual([
      { orderLineId: 'a', netKg: 16_120 },
      { orderLineId: 'b', netKg: 8_060 },
    ]);
  });
  it('single line gets all; all-zero plan splits evenly; ties go to plan order', () => {
    expect(splitProRata(10, [{ orderLineId: 'a', plannedKg: 5 }])).toEqual([{ orderLineId: 'a', netKg: 10 }]);
    expect(
      splitProRata(10, [
        { orderLineId: 'a', plannedKg: 0 },
        { orderLineId: 'b', plannedKg: 0 },
        { orderLineId: 'c', plannedKg: 0 },
      ]).map((x) => x.netKg),
    ).toEqual([4, 3, 3]);
    expect(
      splitProRata(1, [
        { orderLineId: 'a', plannedKg: 1 },
        { orderLineId: 'b', plannedKg: 1 },
      ]).map((x) => x.netKg),
    ).toEqual([1, 0]);
  });
  it('empty plan throws', () => {
    expect(() => splitProRata(5, [])).toThrow();
  });
  it('property: always sums to net and never goes negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 1, maxLength: 5 }),
        (net, planned) => {
          const out = splitProRata(
            net,
            planned.map((p, i) => ({ orderLineId: `l${i}`, plannedKg: p })),
          );
          expect(out.reduce((s, x) => s + x.netKg, 0)).toBe(net);
          expect(out.every((x) => Number.isInteger(x.netKg) && x.netKg >= 0)).toBe(true);
        },
      ),
    );
  });
});

describe('nextTruckState', () => {
  it('gross only from loading; at gate optional; cancel from any open state', () => {
    expect(nextTruckState('assigned', 'tare')).toBe('loading');
    expect(nextTruckState('assigned', 'gross')).toBeNull();
    expect(nextTruckState('dispatched', 'cancel')).toBeNull();
    expect(nextTruckState('assigned', 'at_gate')).toBe('at_gate');
    expect(nextTruckState('at_gate', 'tare')).toBe('loading');
    expect(nextTruckState('loading', 'tare')).toBe('loading');
    expect(nextTruckState('loading', 'gross')).toBe('dispatched');
    expect(nextTruckState('at_gate', 'gross')).toBeNull();
    expect(nextTruckState('loading', 'at_gate')).toBeNull();
    expect(nextTruckState('loading', 'cancel')).toBe('cancelled');
    expect(nextTruckState('cancelled', 'cancel')).toBeNull();
    expect(nextTruckState('cancelled', 'tare')).toBeNull();
  });
});

describe('weights', () => {
  it('netKg is gross minus tare', () => {
    expect(netKg(40_000, 15_820)).toBe(24_180);
  });
  it('plausibility 50 % / 150 % boundaries are ok, beyond them low / high', () => {
    expect(plausibility(12_000, 24_000)).toBe('ok');
    expect(plausibility(11_999, 24_000)).toBe('low');
    expect(plausibility(36_000, 24_000)).toBe('ok');
    expect(plausibility(36_001, 24_000)).toBe('high');
    expect(plausibility(5, 0)).toBe('ok');
  });
  it('checkAllocations: mismatch, removed line, invalid weight', () => {
    const ids = new Set(['a', 'b']);
    const ok = [
      { orderLineId: 'a', netKg: 10 },
      { orderLineId: 'b', netKg: 5 },
    ];
    expect(checkAllocations(15, ok, ids)).toBe('ok');
    expect(checkAllocations(16, ok, ids)).toBe('ALLOC_MISMATCH');
    expect(checkAllocations(15, [{ orderLineId: 'z', netKg: 15 }], ids)).toBe('LINE_REMOVED');
    expect(checkAllocations(0, [], ids)).toBe('INVALID_WEIGHT');
    expect(checkAllocations(-1, ok, ids)).toBe('INVALID_WEIGHT');
    expect(checkAllocations(5, [{ orderLineId: 'a', netKg: -5 }, { orderLineId: 'b', netKg: 10 }], ids)).toBe(
      'INVALID_WEIGHT',
    );
  });
});

describe('tolerance', () => {
  const lines = [{ orderedKg: 24_000, dispatchedKg: 23_400, closedKg: 0, reservedKg: 0 }];
  it('tolerance close waits for the last open truck', () => {
    expect(toleranceCloseKg(lines, 1_000, 1)).toBeNull();
    expect(toleranceCloseKg(lines, 1_000, 0)).toEqual([600]);
  });
  it('null when over tolerance or nothing dispatched', () => {
    expect(toleranceCloseKg(lines, 500, 0)).toBeNull();
    expect(toleranceCloseKg([{ orderedKg: 100, dispatchedKg: 0, closedKg: 0, reservedKg: 0 }], 1_000, 0)).toBeNull();
  });
  it('one entry per line in input order', () => {
    const two = [
      { orderedKg: 100, dispatchedKg: 90, closedKg: 0, reservedKg: 0 },
      { orderedKg: 100, dispatchedKg: 0, closedKg: 0, reservedKg: 0 },
    ];
    expect(toleranceCloseKg(two, 1_000, 0)).toEqual([10, 100]);
  });
  it('overToleranceKg', () => {
    const o = [
      { orderedKg: 100, dispatchedKg: 130, closedKg: 0, reservedKg: 0 },
      { orderedKg: 100, dispatchedKg: 100, closedKg: 0, reservedKg: 0 },
    ];
    expect(overToleranceKg(o, 20)).toBe(30);
    expect(overToleranceKg(o, 30)).toBe(0);
  });
});

describe('constants', () => {
  it('are fixed', () => {
    expect(CLOCK_SKEW_FLAG_MS).toBe(300_000);
    expect(TRUCK_CANCEL_REASONS).toEqual(['Vehicle did not arrive', 'Order short closed', 'Wrong vehicle', 'Other']);
  });
});
