import { expect, it } from 'vitest';
import { ACTIONS, can, plantRule, plantScope, scopeKind, describeRole, type Action } from './policy.ts';
import type { Role } from './roles.ts';
import { ROLES } from './roles.ts';
import { MONEY_KEYS } from './redact.ts';

const T = (role: Role, allowed: readonly Action[]) =>
  ACTIONS.forEach((a) => expect([role, a, can(role, a)]).toEqual([role, a, allowed.includes(a)]));

it('owner', () => T('owner', ACTIONS));
it('city_staff', () =>
  T('city_staff', ['order.create','order.edit','order.duplicate','order.shortClose','order.view','truck.assign','truck.edit','truck.cancel','dispatch.view','masters.manage','import.run','broker.pay','reports.view','money.view','self.view']));
it('plant_head', () => T('plant_head', ['order.view','dispatch.view','self.view']));
it('supervisor', () => T('supervisor', ['weighment.capture','tasks.view','reports.doneToday','self.view']));
it('scope and plant rules', () => {
  expect(plantRule('supervisor')).toEqual({ min: 1, max: 1 });
  expect(plantRule('plant_head')).toEqual({ min: 1, max: Infinity });
  expect(plantRule('owner')).toEqual({ min: 0, max: 0 });
  expect(scopeKind('plant_head')).toBe('plants');
  expect(scopeKind('owner')).toBe('all');
  expect(MONEY_KEYS.has('rate')).toBe(true);
});
it('describeRole returns fresh arrays for every role', () => {
  for (const r of ROLES) {
    const d = describeRole(r);
    expect(d.can.length).toBeGreaterThan(0);
    d.can.push('x');
    expect(describeRole(r).can).not.toContain('x');
  }
  expect(describeRole('owner').cannot).toEqual([]);
});
it('plantScope: owner/city_staff → all; plant roles → a copy of their plants', () => {
  expect(plantScope({ role: 'owner', plantIds: [] })).toEqual({ kind: 'all' });
  expect(plantScope({ role: 'city_staff', plantIds: ['x'] })).toEqual({ kind: 'all' });
  const ids = ['p1'];
  const s = plantScope({ role: 'supervisor', plantIds: ids });
  expect(s).toEqual({ kind: 'plants', plantIds: ['p1'] });
  ids.push('p2');
  expect(s).toEqual({ kind: 'plants', plantIds: ['p1'] });
  expect(plantScope({ role: 'plant_head', plantIds: ['a', 'b'] })).toEqual({
    kind: 'plants',
    plantIds: ['a', 'b'],
  });
});
it('rejections.manage is owner only', () => {
  expect(ROLES.filter((r) => can(r, 'rejections.manage'))).toEqual(['owner']);
});
