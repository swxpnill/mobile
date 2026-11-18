import { createMemoryDeviceStore, displayTasks } from '../src/offline/deviceStore';
import {
  TRUCK_A,
  TRUCK_B,
  atGate,
  deviceStoreContract,
  gross,
  page,
  tare,
  task,
} from '../src/offline/deviceStoreContract';

describe('device store contract (memory)', () => {
  for (const c of deviceStoreContract) {
    it(c.name, () => c.run(async (clock) => createMemoryDeviceStore({ now: clock.now })));
  }
});

describe('displayTasks', () => {
  it('re-applies pending local events over the server tasks', async () => {
    const store = createMemoryDeviceStore();
    await store.replaceTasks(page([task(TRUCK_A), task(TRUCK_B)]));
    await store.saveCapture(atGate(TRUCK_A));
    const localTare = await store.saveCapture(tare(TRUCK_A, 11_500));
    await store.saveCapture(gross(TRUCK_B));

    const shown = displayTasks(await store.getTasks(), await store.outbox());

    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      truckId: TRUCK_A,
      state: 'loading',
      tareKg: 11_500,
      tareAt: localTare.capturedAtDevice, // the local tare's time, not the server's
      localPending: true,
    });
  });

  it('ignores accepted, rejected and blocked events, and flags untouched trucks as not pending', async () => {
    const store = createMemoryDeviceStore();
    await store.replaceTasks(page([task(TRUCK_A), task(TRUCK_B)]));
    const t = await store.saveCapture(tare(TRUCK_A));
    await store.saveCapture(gross(TRUCK_A));
    await store.markResults([
      { status: 'rejected', eventId: t.eventId, code: 'TRUCK_CANCELLED', message: 'x' },
    ]);

    const shown = displayTasks(await store.getTasks(), await store.outbox());

    expect(shown.map((s) => [s.truckId, s.state, s.tareKg, s.localPending])).toEqual([
      [TRUCK_A, 'assigned', null, false],
      [TRUCK_B, 'assigned', null, false],
    ]);
  });

  it('counts an event in flight (sending) as local', async () => {
    const store = createMemoryDeviceStore();
    await store.replaceTasks(page([task(TRUCK_A)]));
    const g = await store.saveCapture(atGate(TRUCK_A));
    await store.markSending([g.eventId]);

    expect(displayTasks(await store.getTasks(), await store.outbox())[0]).toMatchObject({
      state: 'at_gate',
      localPending: true,
    });
  });
});
