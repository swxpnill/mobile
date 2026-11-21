import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Truck,
  dispatchBoardSchema,
  doneTodaySchema,
  homeSchema,
  notificationPageSchema,
  tasksPageSchema,
  truckSchema,
} from '@tonnage/shared';
import {
  DEVICE_B,
  MINUTE,
  PEOPLE,
  RANDOM_ID,
  type ContractTarget,
  type TargetFactory,
  call,
  expectError,
  expectOk,
  newKey,
  tokenFor,
  useTarget,
} from '../harness.ts';
import { approve, approveCall, arrive, assign, canvasWithTruck, getOrder, getTruck, lineIn, phone, sync, synced } from './sync.contract.ts';

/**
 * TON-57 (revised 2026-11-20): saving the weights puts a truck in `weighed` ("Awaiting approval");
 * the owner or city staff approve it, and that approval is the dispatch.
 */

/** Ravi marks the truck arrived, weighs tare 12,460 and gross 36,640 (24,180 kg on `lineId`). */
export async function weighOnPhone(t: ContractTarget, truckId: string, lineId: string, netKg = 24_180) {
  const ravi = await tokenFor(t, PEOPLE.ravi);
  const p = phone(truckId, () => t.clock.now());
  await arrive(t, truckId);
  const results = await synced(sync(t, ravi, [p.tare(12_460), p.gross(12_460 + netKg, [{ orderLineId: lineId, netKg }])]));
  expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  return { ravi, p, results };
}

const correct = (t: ContractTarget, token: string, truck: Truck, lineId: string, grossKg: number, tareKg = 12_460) =>
  call(t, 'POST', `/v1/trucks/${truck.id}/correct-weight`, {
    token,
    idempotencyKey: newKey(),
    body: { tareKg, grossKg, allocations: [{ orderLineId: lineId, netKg: grossKg - tareKg }], reason: 'Weighbridge re-read', version: truck.version },
  });

const board = async (t: ContractTarget, token: string, state = 'open') =>
  expectOk(await call(t, 'GET', `/v1/dispatch?state=${state}`, { token }), dispatchBoardSchema);

export function register(factory: TargetFactory): void {
  describe('contract: office approves dispatch (TON-57)', () => {
    const target = useTarget(factory);
    let startedAt = 0;
    beforeEach(() => {
      startedAt = target().clock.now();
    });
    afterEach(() => {
      const t = target();
      t.clock.advance(startedAt - t.clock.now());
    });

    it('saving the weights sends the truck for approval: no slip, no earning, nothing dispatched, off the task list', async () => {
      const t = target();
      const { owner, order, aLine, truck } = await canvasWithTruck(t);
      const { ravi, results } = await weighOnPhone(t, truck.id, aLine.id);

      const gross = results[1]!;
      expect(gross).toEqual({ status: 'accepted', eventId: expect.any(String), task: null });

      const detail = await getTruck(t, owner, truck.id);
      expect(detail).toMatchObject({ state: 'weighed', tareKg: 12_460, grossKg: 36_640, netKg: 24_180, loadingSlipNo: null, dispatchedAt: null });
      expect(detail.weighedAt).toEqual(expect.any(String));
      expect(detail.allocations).toEqual([{ orderLineId: aLine.id, netKg: 24_180 }]);
      expect(detail.earningRupees ?? 0).toBe(0);

      const line = lineIn(await getOrder(t, owner, order.id), aLine.id);
      expect(line.dispatchedKg).toBe(0);

      const tasks = expectOk(await call(t, 'GET', '/v1/supervisor/tasks', { token: ravi }), tasksPageSchema);
      expect(tasks.items.map((x) => x.truckId)).not.toContain(truck.id);
    });

    it('city staff approve: dispatched at approval time with a slip and the earning; a replay returns the first answer', async () => {
      const t = target();
      const { order, aLine, truck } = await canvasWithTruck(t);
      await weighOnPhone(t, truck.id, aLine.id);
      t.clock.advance(20 * MINUTE);
      // Signed in after the clock moved: access tokens expire.
      const owner = await tokenFor(t, PEOPLE.rajesh);
      const priya = await tokenFor(t, PEOPLE.priya);
      const weighed = await getTruck(t, owner, truck.id);

      const key = newKey();
      const first = await approveCall(t, priya, weighed, key);
      const approved = expectOk(first, truckSchema);
      expect(approved).toMatchObject({ state: 'dispatched', netKg: 24_180, dispatchedAt: new Date(t.clock.now()).toISOString() });
      expect(approved.loadingSlipNo).toMatch(/^LS-AIP-\d{4}-\d{4}$/);
      expect(approved.version).toBeGreaterThan(weighed.version);
      expect((await getTruck(t, owner, truck.id)).earningRupees).toBe(10_881);
      expect(lineIn(await getOrder(t, owner, order.id), aLine.id).dispatchedKg).toBe(24_180);

      const replay = await approveCall(t, priya, weighed, key);
      expect(replay.body).toEqual(first.body);
      expectError(await approveCall(t, priya, approved), 409, 'NOT_AWAITING_APPROVAL');
      expect((await getTruck(t, owner, truck.id)).loadingSlipNo).toBe(approved.loadingSlipNo);
    });

    it('approval refusals: stale version, no key, plant roles, a truck not weighed, an unknown truck', async () => {
      const t = target();
      const { owner, a, aLine, truck } = await canvasWithTruck(t);
      const loading = await assign(t, owner, a.id, aLine.id, 1_000, 'CG 04 AA 1111');
      await weighOnPhone(t, truck.id, aLine.id);
      const weighed = await getTruck(t, owner, truck.id);

      expectError(await approveCall(t, owner, { id: truck.id, version: weighed.version - 1 }), 409, 'STALE');
      expectError(await approveCall(t, owner, weighed, null), 400, 'IDEMPOTENCY_KEY_REQUIRED');
      expectError(await approveCall(t, await tokenFor(t, PEOPLE.kiran), weighed), 403, 'FORBIDDEN');
      expectError(await approveCall(t, await tokenFor(t, PEOPLE.ravi), weighed), 403, 'FORBIDDEN');
      expectError(await approveCall(t, owner, loading), 409, 'NOT_AWAITING_APPROVAL');
      expectError(await approveCall(t, owner, { id: RANDOM_ID, version: 1 }), 404, 'NOT_FOUND');
      expect((await getTruck(t, owner, truck.id)).state).toBe('weighed');
    });

    it('the phone cannot weigh a weighed truck again: TARE and a new GROSS are ALREADY_WEIGHED; a late arrival is a no-op', async () => {
      const t = target();
      const { owner, aLine, truck } = await canvasWithTruck(t);
      const { ravi, p } = await weighOnPhone(t, truck.id, aLine.id);
      const before = await getTruck(t, owner, truck.id);

      const late = p.atGate();
      const results = await synced(sync(t, ravi, [late, p.tare(12_000)]));
      expect(results[0]).toEqual({ status: 'accepted', eventId: late.eventId, task: null });
      expect(results[1]).toMatchObject({ status: 'rejected', code: 'ALREADY_WEIGHED', server: { state: 'weighed' } });
      // A second phone (not blocked behind the first one's refusal) sends its own weights.
      const other = phone(truck.id, () => t.clock.now());
      const [again] = await synced(sync(t, ravi, [other.gross(36_000, [{ orderLineId: aLine.id, netKg: 23_540 }])], { deviceId: DEVICE_B }));
      expect(again).toMatchObject({ status: 'rejected', code: 'ALREADY_WEIGHED', server: { state: 'weighed' } });
      const after = await getTruck(t, owner, truck.id);
      expect({ ...after, version: 0 }).toEqual({ ...before, version: 0 });
    });

    it('owner and city staff change the weights before approval; the approval then uses them', async () => {
      const t = target();
      const { owner, aLine, truck } = await canvasWithTruck(t);
      await weighOnPhone(t, truck.id, aLine.id);
      const priya = await tokenFor(t, PEOPLE.priya);

      expectError(await correct(t, await tokenFor(t, PEOPLE.kiran), await getTruck(t, owner, truck.id), aLine.id, 36_000), 403, 'FORBIDDEN');
      const changed = expectOk(await correct(t, priya, await getTruck(t, owner, truck.id), aLine.id, 36_460), truckSchema);
      expect(changed).toMatchObject({ state: 'weighed', grossKg: 36_460, netKg: 24_000, loadingSlipNo: null });
      expect(changed.weighments.map((w) => [w.kind, w.kg, w.superseded])).toEqual([
        ['tare', 12_460, true],
        ['gross', 36_640, true],
        ['tare', 12_460, false],
        ['gross', 36_460, false],
      ]);
      expect((await getTruck(t, owner, truck.id)).earningRupees ?? 0).toBe(0);

      const approved = await approve(t, truck.id, priya);
      expect(approved.netKg).toBe(24_000);
      // 24.000 MT × (₹150 + ₹300)
      expect((await getTruck(t, owner, truck.id)).earningRupees).toBe(10_800);

      // After approval it is the existing correction: the earning follows the new weights.
      expectOk(await correct(t, priya, await getTruck(t, owner, truck.id), aLine.id, 36_640), truckSchema);
      expect((await getTruck(t, owner, truck.id)).earningRupees).toBe(10_881);
    });

    it('weights cannot be changed on a truck still loading', async () => {
      const t = target();
      const { owner, aLine, truck } = await canvasWithTruck(t);
      const ravi = await tokenFor(t, PEOPLE.ravi);
      await arrive(t, truck.id);
      await synced(sync(t, ravi, [phone(truck.id, () => t.clock.now()).tare(12_460)]));
      expectError(await correct(t, owner, await getTruck(t, owner, truck.id), aLine.id, 36_640), 409, 'TRUCK_LOCKED');
    });

    it('not approving: a weighed truck can be cancelled; its plan is locked, its driver is not', async () => {
      const t = target();
      const { owner, aLine, truck } = await canvasWithTruck(t);
      await weighOnPhone(t, truck.id, aLine.id);
      const patch = async (body: Record<string, unknown>) =>
        call(t, 'PATCH', `/v1/trucks/${truck.id}`, { token: owner, idempotencyKey: newKey(), body: { ...body, version: (await getTruck(t, owner, truck.id)).version } });

      expectError(await patch({ plan: [{ orderLineId: aLine.id, plannedKg: 20_000 }] }), 409, 'TRUCK_LOCKED');
      expect(expectOk(await patch({ driverName: 'Suresh' }), truckSchema).driverName).toBe('Suresh');

      const cancelled = expectOk(
        await call(t, 'POST', `/v1/trucks/${truck.id}/cancel`, {
          token: owner,
          idempotencyKey: newKey(),
          body: { reason: 'Wrong vehicle', note: 'Loaded the wrong size', version: (await getTruck(t, owner, truck.id)).version },
        }),
        truckSchema,
      );
      expect(cancelled.state).toBe('cancelled');
      expectError(await approveCall(t, owner, cancelled), 409, 'NOT_AWAITING_APPROVAL');
    });

    it('board: To approve count and filter, first in Open; dispatched today and Home only after approval', async () => {
      const t = target();
      const { owner, a, aLine, truck } = await canvasWithTruck(t);
      await assign(t, owner, a.id, aLine.id, 1_000, 'CG 04 AA 1111');
      const home = async () => expectOk(await call(t, 'GET', '/v1/home', { token: owner }), homeSchema).dispatchedToday;
      const homeBefore = await home();
      await weighOnPhone(t, truck.id, aLine.id);

      const open = await board(t, owner);
      expect(open.counts.weighed).toBe(1);
      expect(open.items[0]).toMatchObject({ id: truck.id, state: 'weighed' });
      expect((await board(t, owner, 'weighed')).items.map((x) => x.id)).toEqual([truck.id]);
      expect((await board(t, owner, 'dispatched_today')).items.map((x) => x.id)).not.toContain(truck.id);
      expect(await home()).toEqual(homeBefore);

      await approve(t, truck.id);
      const after = await board(t, owner);
      expect(after.counts.weighed).toBe(0);
      expect((await board(t, owner, 'dispatched_today')).items.map((x) => x.id)).toContain(truck.id);
      expect(await home()).toEqual({ kg: homeBefore.kg + 24_180, trucks: homeBefore.trucks + 1 });
    });

    it('plant head sees the weighed truck, without money', async () => {
      const t = target();
      const { aLine, truck } = await canvasWithTruck(t);
      await weighOnPhone(t, truck.id, aLine.id);
      const kiran = await tokenFor(t, PEOPLE.kiran);
      expect((await board(t, kiran, 'weighed')).items.map((x) => x.id)).toEqual([truck.id]);
      expect('earningRupees' in (await getTruck(t, kiran, truck.id))).toBe(false);
    });

    it('done today: awaiting approval with no slip, then dispatched with its slip', async () => {
      const t = target();
      const { aLine, truck } = await canvasWithTruck(t);
      const { ravi } = await weighOnPhone(t, truck.id, aLine.id);
      const done = async () => expectOk(await call(t, 'GET', '/v1/supervisor/done-today', { token: ravi }), doneTodaySchema);

      const waiting = await done();
      expect(waiting.items).toEqual([
        expect.objectContaining({ truckId: truck.id, status: 'awaiting_approval', netKg: 24_180, loadingSlipNo: null, dispatchedAt: null, weighedAt: expect.any(String) }),
      ]);
      expect(waiting.totalNetKg).toBe(24_180);

      const approved = await approve(t, truck.id);
      expect((await done()).items).toEqual([
        expect.objectContaining({ truckId: truck.id, status: 'dispatched', loadingSlipNo: approved.loadingSlipNo, dispatchedAt: approved.dispatchedAt }),
      ]);
    });

    it('who is told: weighing asks owner and city staff; approving tells the others, not the approver', async () => {
      const t = target();
      const { aLine, truck } = await canvasWithTruck(t);
      await weighOnPhone(t, truck.id, aLine.id);
      const kinds = async (who: { mobile: string }) =>
        expectOk(await call(t, 'GET', '/v1/notifications', { token: await tokenFor(t, who) }), notificationPageSchema).items
          .filter((n) => (n.kind === 'truck.weighed' || n.kind === 'truck.dispatched') && n.data.truckId === truck.id)
          .map((n) => n.kind);

      expect(await kinds(PEOPLE.priya)).toEqual(['truck.weighed']);
      expect(await kinds(PEOPLE.amit)).toEqual(['truck.weighed']);
      expect(await kinds(PEOPLE.kiran)).toEqual([]);

      await approve(t, truck.id, await tokenFor(t, PEOPLE.priya));
      expect(await kinds(PEOPLE.priya)).toEqual(['truck.weighed']);
      expect(await kinds(PEOPLE.amit)).toEqual(['truck.dispatched', 'truck.weighed']);
      expect(await kinds(PEOPLE.kiran)).toEqual(['truck.dispatched']);
      expect(await kinds(PEOPLE.ravi)).toEqual(['truck.dispatched']);
    });
  });
}
