// Request vehicle (Task 4): the sheet's pure state, without rendering.
import {
  type RvLine,
  initRequestState,
  requestVehicleReducer as reduce,
  selection,
  totalKg,
} from '../src/screens/orders/requestVehicleState';

const LINES: RvLine[] = [
  { id: 'l1', subOrderId: 's1', pendingKg: 24_000 },
  { id: 'l2', subOrderId: 's1', pendingKg: 10_000 },
  { id: 'l3', subOrderId: 's2', pendingKg: 30_000 },
];

describe('requestVehicleState', () => {
  it('starts on All pending with every open line at its pending', () => {
    const s = initRequestState(LINES);
    expect(s.material).toBe('all');
    expect(selection(s)).toEqual([
      { orderLineId: 'l1', kg: 24_000 },
      { orderLineId: 'l2', kg: 10_000 },
      { orderLineId: 'l3', kg: 30_000 },
    ]);
    expect(totalKg(s)).toBe(64_000);
  });

  it('One company takes the chosen sub-order at its pending', () => {
    let s = reduce(initRequestState(LINES), { type: 'material', material: 'company' });
    expect(selection(s).map((l) => l.orderLineId)).toEqual(['l1', 'l2']);
    s = reduce(s, { type: 'subOrder', subOrderId: 's2' });
    expect(selection(s)).toEqual([{ orderLineId: 'l3', kg: 30_000 }]);
  });

  it('switching to Pick lines keeps the kg already selected', () => {
    const fromAll = reduce(initRequestState(LINES), { type: 'material', material: 'lines' });
    expect(totalKg(fromAll)).toBe(64_000);
    let s = reduce(initRequestState(LINES), { type: 'material', material: 'company' });
    s = reduce(s, { type: 'subOrder', subOrderId: 's2' });
    s = reduce(s, { type: 'material', material: 'lines' });
    expect(selection(s)).toEqual([{ orderLineId: 'l3', kg: 30_000 }]);
    expect(s.picks.l1).toEqual({ on: false, kg: 24_000 });
  });

  it('typing above pending clamps to pending; more than 3 decimals and a minus are dropped', () => {
    let s = reduce(initRequestState(LINES), { type: 'material', material: 'lines' });
    s = reduce(s, { type: 'lineText', lineId: 'l3', text: '35', basis: 'mt' });
    expect(s.picks.l3).toEqual({ on: true, kg: 30_000 });
    expect(s.texts.l3).toBe('30.000');
    s = reduce(s, { type: 'lineText', lineId: 'l1', text: '-12.34567', basis: 'mt' });
    expect(s.picks.l1).toEqual({ on: true, kg: 12_345 });
    expect(s.texts.l1).toBe('12.345');
    s = reduce(s, { type: 'lineText', lineId: 'l2', text: '4500', basis: 'kg' });
    expect(s.picks.l2).toEqual({ on: true, kg: 4_500 });
  });

  it('an empty field (or 0) gives 0 and unticks the line', () => {
    let s = reduce(initRequestState(LINES), { type: 'material', material: 'lines' });
    s = reduce(s, { type: 'lineText', lineId: 'l1', text: '', basis: 'mt' });
    expect(s.picks.l1).toEqual({ on: false, kg: 0 });
    expect(selection(s).map((l) => l.orderLineId)).toEqual(['l2', 'l3']);
    s = reduce(s, { type: 'lineText', lineId: 'l2', text: '0', basis: 'mt' });
    expect(s.picks.l2?.on).toBe(false);
    // Ticking a line at 0 asks for its whole pending again.
    s = reduce(s, { type: 'toggleLine', lineId: 'l1' });
    expect(s.picks.l1).toEqual({ on: true, kg: 24_000 });
    s = reduce(s, { type: 'lineBlur', lineId: 'l1' });
    expect(s.texts.l1).toBeUndefined();
  });

  it('the message follows the selection until edited; then a change only marks it stale', () => {
    let s = reduce(initRequestState(LINES), { type: 'compose', text: 'A' });
    expect(s.message).toBe('A');
    s = reduce(s, { type: 'compose', text: 'B' });
    expect(s.message).toBe('B');
    s = reduce(s, { type: 'editMessage', text: 'mine' });
    expect(s.messageEdited).toBe(true);
    s = reduce(s, { type: 'material', material: 'company' });
    s = reduce(s, { type: 'compose', text: 'C' });
    expect(s.message).toBe('mine');
    expect(s.messageStale).toBe(true);
    s = reduce(s, { type: 'refreshMessage' });
    expect(s).toMatchObject({ message: 'C', messageEdited: false, messageStale: false });
  });

  it('an edited message that is re-composed to the same text is not stale', () => {
    let s = reduce(initRequestState(LINES), { type: 'compose', text: 'A' });
    s = reduce(s, { type: 'editMessage', text: 'mine' });
    s = reduce(s, { type: 'compose', text: 'A' });
    expect(s.messageStale).toBe(false);
  });

  it('a prefill restores its lines and kg on Pick lines', () => {
    const s = initRequestState(LINES, { lines: [{ orderLineId: 'l3', kg: 12_000 }, { orderLineId: 'gone', kg: 5 }] });
    expect(s.material).toBe('lines');
    expect(selection(s)).toEqual([{ orderLineId: 'l3', kg: 12_000 }]);
  });

  it('a refetch with less pending clamps the kg; with nothing pending the total is 0', () => {
    let s = reduce(initRequestState(LINES), { type: 'material', material: 'lines' });
    s = reduce(s, { type: 'lines', lines: [{ id: 'l3', subOrderId: 's2', pendingKg: 5_000 }] });
    expect(selection(s)).toEqual([{ orderLineId: 'l3', kg: 5_000 }]);
    s = reduce(s, { type: 'lines', lines: [] });
    expect(totalKg(s)).toBe(0);
    expect(totalKg(reduce(initRequestState(LINES), { type: 'lines', lines: [] }))).toBe(0);
  });

  it('keeps the recipient it is given', () => {
    const s = reduce(initRequestState(LINES), { type: 'recipient', recipient: { partyId: 'p', contactId: 'c', numberId: 'n' } });
    expect(s.recipient).toEqual({ partyId: 'p', contactId: 'c', numberId: 'n' });
  });
});
