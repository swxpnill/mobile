import { describe, expect, it } from 'vitest';
import type { Role } from '../roles.ts';
import { planOrderEdit, type EditLineExisting, type EditLineDesired } from './edits.ts';

const ex = (o: Partial<EditLineExisting> & { lineId: string }): EditLineExisting => ({
  productKey: 'tmt16|12m',
  orderedKg: 40_000,
  rate: 46_500,
  overpricePerMt: 0,
  dispatchedKg: 0,
  reservedKg: 0,
  terminal: false,
  ...o,
});
const want = (o: Partial<EditLineDesired>): EditLineDesired => ({
  productKey: 'tmt16|12m',
  orderedKg: 40_000,
  rate: 46_500,
  overpricePerMt: 0,
  terminal: false,
  ...o,
});
const codes = (role: Role, existing: EditLineExisting[], desired: EditLineDesired[]) =>
  planOrderEdit({ role, existing, desired }).errors.map((e) => e.code);

const dispatched = ex({ lineId: 'L1', dispatchedKg: 28_400, reservedKg: 5_000 });
const untouched = ex({ lineId: 'L2', productKey: 'tmt25|6m', orderedKg: 30_000, rate: 45_800 });

describe('planOrderEdit (§5.3 edits after dispatch starts)', () => {
  it('no change → no errors, no warnings', () => {
    const r = planOrderEdit({ role: 'city_staff', existing: [dispatched], desired: [want({ lineId: 'L1' })] });
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it('city staff may add lines and change undispatched lines freely', () => {
    expect(
      codes('city_staff', [dispatched, untouched], [
        want({ lineId: 'L1' }),
        want({ lineId: 'L2', productKey: 'tmt25|6m', orderedKg: 35_000, rate: 46_000 }),
        want({ productKey: 'tmt20|12m', orderedKg: 10_000, rate: 46_000 }),
      ]),
    ).toEqual([]);
  });

  it('a line with dispatches is rate-locked for city staff, not for the owner', () => {
    const desired = [want({ lineId: 'L1', rate: 47_000 })];
    expect(codes('city_staff', [dispatched], desired)).toEqual(['LINE_RATE_LOCKED']);
    expect(codes('city_staff', [dispatched], [want({ lineId: 'L1', overpricePerMt: 100 })])).toEqual(['LINE_RATE_LOCKED']);
    expect(codes('owner', [dispatched], desired)).toEqual([]);
  });

  it('nobody may order less than was dispatched; city staff may still change quantity above it', () => {
    expect(codes('owner', [dispatched], [want({ lineId: 'L1', orderedKg: 28_000 })])).toEqual(['BELOW_DISPATCHED']);
    expect(codes('city_staff', [dispatched], [want({ lineId: 'L1', orderedKg: 30_000 })])).toEqual([]);
  });

  it('below dispatched + reserved is only a warning', () => {
    const r = planOrderEdit({ role: 'city_staff', existing: [dispatched], desired: [want({ lineId: 'L1', orderedKg: 30_000 })] });
    expect(r.warnings).toEqual([{ lineId: 'L1', code: 'BELOW_RESERVED' }]);
  });

  it('a line with dispatches cannot be removed or switched to another product/length, even by the owner', () => {
    expect(codes('owner', [dispatched], [])).toEqual(['LINE_HAS_DISPATCHES']);
    expect(codes('owner', [dispatched], [want({ lineId: 'L1', productKey: 'tmt20|12m' })])).toEqual(['LINE_HAS_DISPATCHES']);
    expect(codes('city_staff', [untouched], [])).toEqual([]);
  });

  it('a closed sub-order is locked for everyone until reopened: no change, no removal, no new line', () => {
    const closed = ex({ lineId: 'L3', terminal: true });
    expect(codes('owner', [closed], [want({ lineId: 'L3', orderedKg: 41_000, terminal: true })])).toEqual(['ORDER_LOCKED']);
    expect(codes('owner', [closed], [])).toEqual(['ORDER_LOCKED']);
    expect(codes('owner', [closed], [want({ lineId: 'L3', terminal: true }), want({ terminal: true })])).toEqual(['ORDER_LOCKED']);
    expect(codes('owner', [closed], [want({ lineId: 'L3', terminal: true })])).toEqual([]);
  });

  it('an id that is not on the order is an error, not a silent new line', () => {
    expect(codes('owner', [untouched], [want({ lineId: 'nope' })])).toEqual(['LINE_NOT_ON_ORDER']);
  });

  it('errors carry the line id so the app can mark the row', () => {
    const r = planOrderEdit({ role: 'city_staff', existing: [dispatched], desired: [want({ lineId: 'L1', rate: 1 })] });
    expect(r.errors).toEqual([{ lineId: 'L1', code: 'LINE_RATE_LOCKED' }]);
  });
});
