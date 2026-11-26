import { SAMPLE_MASTERS, SAMPLE_WORLD } from '@tonnage/shared';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { normaliseIds } from './support/normalise.ts';

const { AIP, KRM } = SAMPLE_WORLD.ids.companies;

describe('the parity normaliser (R2)', () => {
  it('renumbers minted ids by first appearance, also inside strings, whatever the key order', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(normaliseIds({ y: [a, b], x: `${b}|cursor` })).toEqual({ x: '#1|cursor', y: ['#2', '#1'] });
  });

  it('keeps ids both sides were seeded with, so a wrong company, person or master is a difference', () => {
    const rajesh = SAMPLE_WORLD.ids.users.rajesh;
    const shubham = SAMPLE_MASTERS.ids.parties.shubham;
    expect(normaliseIds({ companyId: AIP, createdBy: rajesh, partyId: shubham })).toEqual({
      companyId: AIP,
      createdBy: rajesh,
      partyId: shubham,
    });
    expect(normaliseIds({ companyId: AIP })).not.toEqual(normaliseIds({ companyId: KRM }));
  });
});
