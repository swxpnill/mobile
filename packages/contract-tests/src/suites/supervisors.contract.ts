import { describe, expect, it } from 'vitest';
import { dispatchBoardSchema, userSchema } from '@tonnage/shared';
import { PEOPLE, PLANT, type TargetFactory, call, expectOk, newKey, tokenFor, useTarget } from '../harness.ts';
import { canvasWithTruck, getTruck } from './sync.contract.ts';

/**
 * TON-57 Ruling 11: a truck's detail lists the active supervisors of its plant (name, mobile,
 * whether they have signed in yet), so the office can call or message them. The board does not.
 */
export function register(factory: TargetFactory): void {
  describe('contract: the plant supervisors on a truck (TON-57)', () => {
    const target = useTarget(factory);

    it('a Siltara truck lists Ravi only: Sanjay works at Borai, Deepak at Tilda', async () => {
      const t = target();
      const { owner, truck } = await canvasWithTruck(t);
      expect(truck.supervisors).toEqual([
        { id: PEOPLE.ravi.id, name: 'Ravi Verma', mobile: '+919826100014', invited: false },
      ]);
      expect((await getTruck(t, owner, truck.id)).supervisors).toEqual(truck.supervisors);
    });

    it('sorted by name; one who never signed in is marked invited; a deactivated one is left out', async () => {
      const t = target();
      const { owner, truck } = await canvasWithTruck(t);
      const naveen = expectOk(
        await call(t, 'POST', '/v1/users', {
          token: owner,
          idempotencyKey: newKey(),
          body: { name: 'Naveen Sahu', mobile: '9826100050', role: 'supervisor', plantIds: [PLANT.siltara] },
        }),
        userSchema,
        201,
      );
      expect((await getTruck(t, owner, truck.id)).supervisors).toEqual([
        { id: naveen.id, name: 'Naveen Sahu', mobile: '+919826100050', invited: true },
        { id: PEOPLE.ravi.id, name: 'Ravi Verma', mobile: '+919826100014', invited: false },
      ]);

      expect((await call(t, 'POST', `/v1/users/${PEOPLE.ravi.id}/deactivate`, { token: owner })).status).toBe(200);
      expect((await getTruck(t, owner, truck.id)).supervisors.map((s) => s.name)).toEqual(['Naveen Sahu']);
    });

    it('the plant head sees them too (a phone number is not money)', async () => {
      const t = target();
      const { truck } = await canvasWithTruck(t);
      const kiran = await tokenFor(t, PEOPLE.kiran);
      expect((await getTruck(t, kiran, truck.id)).supervisors.map((s) => s.name)).toEqual(['Ravi Verma']);
    });

    it('the Dispatch board carries no supervisors', async () => {
      const t = target();
      const { owner, truck } = await canvasWithTruck(t);
      const board = expectOk(await call(t, 'GET', '/v1/dispatch', { token: owner }), dispatchBoardSchema);
      const item = board.items.find((x) => x.id === truck.id)!;
      expect(item).toBeDefined();
      expect('supervisors' in item).toBe(false);
    });
  });
}
