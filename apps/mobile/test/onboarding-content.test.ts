import { ACTIONS, type Role, can } from '@tonnage/shared';
import { tabsForRole } from '../src/nav/tabs';
import { INTRO, ROLE_TOUR_NAME, stepsFor, tourSummary } from '../src/onboarding/tours';
import { TIPS, tipFor } from '../src/onboarding/tips';
import { howToFor } from '../src/onboarding/howTo';

const ROLES: Role[] = ['owner', 'city_staff', 'plant_head', 'supervisor'];
const RETIRED = /gross weighed|save to dispatch|weights & dispatch/i;

describe('tour content', () => {
  it.each([
    ['owner', ['Units', 'Pending', 'Live', 'Create', 'Orders', 'Dispatch', 'More', 'Done']],
    ['city_staff', ['Units', 'Pending', 'Create', 'Orders', 'Dispatch', 'More', 'Done']],
    ['plant_head', ['Home', 'Live', 'Orders', 'Dispatch', 'More', 'Done']],
    ['supervisor', ['Today', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'Done', 'Ready']],
  ] as const)('%s tour has the right steps in order', (role, tags) => {
    expect(stepsFor(role, 'X').map((s) => s.tag)).toEqual(tags);
    expect(tourSummary(role).steps).toBe(tags.length - 1);
  });

  it('every tab target is one of the role’s tabs and every requirement is allowed', () => {
    for (const role of ROLES) {
      for (const s of stepsFor(role, 'X')) {
        if (s.target?.startsWith('tab.')) expect(tabsForRole(role)).toContain(s.target.slice(4));
        if (s.requires) expect(can(role, s.requires)).toBe(true);
      }
    }
    expect(stepsFor('plant_head', 'X').some((s) => s.target === 'tab.new')).toBe(false);
    for (const s of stepsFor('supervisor', 'X')) {
      if (s.target) expect(s.target).toMatch(/^(tasks\.|tab\.(tasks|done|profile)$)/);
    }
  });

  it('no copy contains a retired phrase', () => {
    const texts: string[] = [];
    for (const role of ROLES) {
      for (const s of stepsFor(role, 'X')) texts.push(s.title, s.body);
      texts.push(INTRO[role].lead, ...INTRO[role].points.flatMap((p) => [p.title, p.body]));
      for (const h of howToFor(role)) texts.push(h.title, ...h.steps);
    }
    for (const t of TIPS) texts.push(t.title, t.body);
    for (const t of texts) expect(t).not.toMatch(RETIRED);
  });

  it('replaces {name} with the first name', () => {
    expect(stepsFor('owner', 'Rajesh').at(-1)?.title).toBe('You’re all set, Rajesh');
    expect(stepsFor('supervisor', 'Ravi').at(-1)?.title).toBe('You’re all set, Ravi');
    expect(JSON.stringify(stepsFor('owner', 'Rajesh'))).not.toContain('{name}');
  });

  it('names every role', () => {
    expect(ROLE_TOUR_NAME).toEqual({
      owner: 'Owner',
      city_staff: 'City staff',
      plant_head: 'Plant head',
      supervisor: 'Supervisor',
    });
  });
});

describe('tips', () => {
  it('are filtered by policy', () => {
    expect(tipFor('plant_head', 'order.requestVehicle')).toBeUndefined();
    expect(tipFor('owner', 'order.requestVehicle')?.title).toBeTruthy();
    expect(tipFor('city_staff', 'attention.first')).toBeUndefined(); // rejections.manage is owner-only
    const sup = TIPS.filter((t) => tipFor('supervisor', t.key)).map((t) => t.key);
    expect(sup).toEqual(expect.arrayContaining(['weigh.lines', 'done.list']));
    for (const office of ['order.requestVehicle', 'dispatch.toApprove', 'ledger.recordPayment', 'reports.firstTile']) {
      expect(sup).not.toContain(office);
    }
  });

  it('cover the nine screens of the design', () => {
    expect(TIPS.map((t) => t.key).sort()).toEqual(
      [
        'attention.first',
        'dispatch.toApprove',
        'done.list',
        'ledger.recordPayment',
        'notifications.list',
        'order.requestVehicle',
        'reports.firstTile',
        'truck.supervisors',
        'weigh.lines',
      ].sort(),
    );
  });
});

describe('how to', () => {
  it('only lists topics the role can do', () => {
    for (const role of ROLES) {
      const topics = howToFor(role);
      expect(topics.length).toBeGreaterThanOrEqual(3);
      for (const h of topics) {
        if (h.requires) {
          expect(ACTIONS).toContain(h.requires);
          expect(can(role, h.requires)).toBe(true);
        }
        expect(h.steps.length).toBeGreaterThanOrEqual(3);
        expect(h.steps.length).toBeLessThanOrEqual(5);
      }
    }
  });
});
