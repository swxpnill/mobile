import { TRUCK_STEPS, stepIndex } from '../src/screens/dispatch/truckStateMeta';

// TON-57: one five-step progress for every screen; the step is how far the truck has got.
describe('stepIndex', () => {
  const none = { tareKg: null, atGateAt: null };
  it('names five steps, Arrived second', () => {
    expect(TRUCK_STEPS).toEqual(['Assigned', 'Arrived', 'Tare weighed', 'Weighed', 'Dispatched']);
  });

  it('follows the state', () => {
    expect(stepIndex({ state: 'assigned', ...none })).toBe(1);
    expect(stepIndex({ state: 'at_gate', tareKg: null, atGateAt: 'x' })).toBe(2);
    expect(stepIndex({ state: 'loading', tareKg: 12_000, atGateAt: 'x' })).toBe(3);
    expect(stepIndex({ state: 'weighed', tareKg: 12_000, atGateAt: 'x' })).toBe(4);
    expect(stepIndex({ state: 'dispatched', tareKg: 12_000, atGateAt: 'x' })).toBe(5);
  });

  it('a cancelled truck shows how far it got', () => {
    expect(stepIndex({ state: 'cancelled', ...none })).toBe(1);
    expect(stepIndex({ state: 'cancelled', tareKg: null, atGateAt: 'x' })).toBe(2);
    expect(stepIndex({ state: 'cancelled', tareKg: 12_000, atGateAt: 'x' })).toBe(3);
  });
});
