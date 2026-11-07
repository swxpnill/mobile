import { describe, expect, it } from 'vitest';
import type { LineQty } from './quantities.ts';
import {
  isTerminal,
  orderStatus,
  subOrderStatus,
  type CloseKind,
  type OrderStatus,
  type SubOrderStatus,
} from './status.ts';

const l = (orderedKg: number, dispatchedKg = 0, closedKg = 0): LineQty => ({
  orderedKg,
  dispatchedKg,
  closedKg,
  reservedKg: 0,
});

describe('subOrderStatus (§5.3, first matching row wins)', () => {
  it.each<[string, CloseKind | null, LineQty[], SubOrderStatus]>([
    ['cancel beats everything', 'cancel', [l(10_000)], 'cancelled'],
    ['short close', 'short_close', [l(10_000, 6_000, 4_000)], 'short_closed'],
    ['tolerance close', 'tolerance', [l(10_000, 9_400, 600)], 'completed'],
    ['pending 0 and dispatched > 0', null, [l(10_000, 10_000)], 'completed'],
    ['over-dispatched is completed', null, [l(10_000, 10_240)], 'completed'],
    ['some dispatched', null, [l(10_000, 2_000)], 'partly_dispatched'],
    ['one line done, one untouched → partly', null, [l(10_000, 10_000), l(5_000)], 'partly_dispatched'],
    ['nothing dispatched', null, [l(10_000)], 'open'],
  ])('%s', (_name, closeKind, lines, expected) => {
    expect(subOrderStatus({ closeKind, lines })).toBe(expected);
  });
});

describe('orderStatus (parent)', () => {
  it.each<[string, boolean, SubOrderStatus[], OrderStatus]>([
    ['draft', true, [], 'draft'],
    ['all cancelled', false, ['cancelled', 'cancelled'], 'cancelled'],
    ['all terminal with a short close', false, ['short_closed', 'completed'], 'short_closed'],
    ['short closed + cancelled', false, ['short_closed', 'cancelled'], 'short_closed'],
    ['all terminal', false, ['completed', 'completed'], 'completed'],
    ['completed + cancelled', false, ['completed', 'cancelled'], 'completed'],
    ['one completed, one open', false, ['completed', 'open'], 'partly_dispatched'],
    ['short closed (with dispatches) + open', false, ['short_closed', 'open'], 'partly_dispatched'],
    ['any partly', false, ['open', 'partly_dispatched'], 'partly_dispatched'],
    ['cancelled + open', false, ['cancelled', 'open'], 'open'],
    ['all open', false, ['open', 'open'], 'open'],
  ])('%s', (_name, isDraft, subOrders, expected) => {
    expect(orderStatus({ isDraft, subOrders })).toBe(expected);
  });
});

describe('isTerminal', () => {
  it('completed, short closed and cancelled are terminal; open and partly are not', () => {
    expect((['completed', 'short_closed', 'cancelled'] as const).every(isTerminal)).toBe(true);
    expect((['open', 'partly_dispatched'] as const).some(isTerminal)).toBe(false);
  });
});
