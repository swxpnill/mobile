import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  companySchema,
  gstinSchema,
  normalizedMobileSchema,
  plantRule,
  SAMPLE_WORLD,
} from '../index.ts';

function collectIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'id' || k.endsWith('Id')) && typeof v === 'string') out.push(v);
      else if (k.endsWith('Ids') && Array.isArray(v)) out.push(...(v as string[]));
      else collectIds(v, out);
    }
  }
  return out;
}

it('every id in SAMPLE_WORLD is a valid zod uuid and ids are unique', () => {
  const ids = [...collectIds(SAMPLE_WORLD), ...collectIds(Object.values(SAMPLE_WORLD.ids))];
  expect(ids.length).toBeGreaterThan(16);
  for (const id of ids) expect(z.uuid().safeParse(id).success, id).toBe(true);
  const own = [
    SAMPLE_WORLD.tenant.id,
    ...SAMPLE_WORLD.companies.map((c) => c.id),
    ...SAMPLE_WORLD.plants.map((p) => p.id),
    ...SAMPLE_WORLD.users.map((u) => u.id),
  ];
  expect(new Set(own).size).toBe(own.length);
});

it('has the canvas sample world', () => {
  expect(SAMPLE_WORLD.tenant.name).toBe('Agrawal Group');
  expect(SAMPLE_WORLD.companies.map((c) => c.code)).toEqual(['AIP', 'VSL', 'KRM', 'NAP']);
  expect(SAMPLE_WORLD.plants).toHaveLength(4);
  expect(SAMPLE_WORLD.users).toHaveLength(8);
  const aip = SAMPLE_WORLD.companies[0];
  expect(aip).toMatchObject({
    name: 'Aarav Ispat Pvt Ltd',
    gstin: '22AAJCA4410K1ZQ',
    orderPrefix: 'SO-AIP',
  });
  for (const c of SAMPLE_WORLD.companies) {
    expect(gstinSchema.safeParse(c.gstin).success).toBe(true);
    expect(companySchema.safeParse({ ...c, active: true, version: 1 }).success).toBe(true);
  }
  const siltara = SAMPLE_WORLD.plants.find((p) => p.id === SAMPLE_WORLD.ids.plants.siltara);
  expect(siltara).toMatchObject({
    name: 'Siltara',
    location: 'Raipur',
    companyId: SAMPLE_WORLD.ids.companies.AIP,
  });
});

it('users follow plant rules and mobile format; Deepak is invited', () => {
  for (const u of SAMPLE_WORLD.users) {
    expect(normalizedMobileSchema.safeParse(u.mobile).success).toBe(true);
    const rule = plantRule(u.role);
    expect(u.plantIds.length).toBeGreaterThanOrEqual(rule.min);
    expect(u.plantIds.length).toBeLessThanOrEqual(rule.max);
  }
  const byName = (n: string) => SAMPLE_WORLD.users.find((u) => u.name === n);
  expect(byName('Rajesh Agrawal')).toMatchObject({ role: 'owner', mobile: '+919826100012' });
  expect(byName('Ravi Verma')).toMatchObject({
    role: 'supervisor',
    plantIds: [SAMPLE_WORLD.ids.plants.siltara],
  });
  expect(byName('Deepak Sahu')).toMatchObject({
    status: 'invited',
    plantIds: [SAMPLE_WORLD.ids.plants.tilda],
  });
  expect(byName('Kiran Rao')).toMatchObject({
    role: 'plant_head',
    plantIds: [SAMPLE_WORLD.ids.plants.siltara],
  });
  expect(SAMPLE_WORLD.users.filter((u) => u.status === 'invited')).toHaveLength(1);
});
