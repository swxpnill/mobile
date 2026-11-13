import { describe, expect, it } from 'vitest';
import { partyBodySchema, productBodySchema } from '../schemas/masters.ts';
import { SAMPLE_MASTERS } from './sample-masters.ts';
import { SAMPLE_WORLD } from './sample-world.ts';

const companyId = (code: string) => SAMPLE_WORLD.companies.find((c) => c.code === code)!.id;

describe('SAMPLE_MASTERS', () => {
  it('8 parties (4 customers, 2 brokers, 2 transporters) and 10 products', () => {
    const count = (t: string) => SAMPLE_MASTERS.parties.filter((p) => p.type === t).length;
    expect([count('customer'), count('broker'), count('transporter')]).toEqual([4, 2, 2]);
    expect(SAMPLE_MASTERS.products).toHaveLength(10);
  });

  it('every seeded party is valid input (same rules as the party form)', () => {
    for (const p of SAMPLE_MASTERS.parties) {
      const r = partyBodySchema.safeParse(p);
      expect(r.success, `${p.name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it('every seeded product is valid input and made by known companies', () => {
    for (const p of SAMPLE_MASTERS.products) {
      const r = productBodySchema.safeParse({ ...p, companyIds: p.companyCodes.map(companyId) });
      expect(r.success, p.sizeLabel).toBe(true);
    }
  });

  it('ids are unique across parties, products, contacts, numbers and addresses', () => {
    const all = [
      ...SAMPLE_MASTERS.parties.flatMap((p) => [
        p.id,
        ...p.addresses.map((a) => a.id),
        ...p.contacts.flatMap((c) => [c.id, ...c.numbers.map((n) => n.id)]),
      ]),
      ...SAMPLE_MASTERS.products.map((p) => p.id),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
