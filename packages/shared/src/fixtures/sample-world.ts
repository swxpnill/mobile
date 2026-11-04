import type { Role } from '../roles.ts';

/**
 * The canvas sample world as plain data. UUIDs are hard-coded, stable and UUIDv7-shaped so that
 * tests, the mock API and the B1 seed all refer to the same records.
 */
const ids = {
  tenant: '019a4c00-0000-7000-8000-000000000001',
  companies: {
    AIP: '019a4c00-0001-7000-8000-000000000001',
    VSL: '019a4c00-0001-7000-8000-000000000002',
    KRM: '019a4c00-0001-7000-8000-000000000003',
    NAP: '019a4c00-0001-7000-8000-000000000004',
  },
  plants: {
    siltara: '019a4c00-0002-7000-8000-000000000001',
    urla: '019a4c00-0002-7000-8000-000000000002',
    borai: '019a4c00-0002-7000-8000-000000000003',
    tilda: '019a4c00-0002-7000-8000-000000000004',
  },
  users: {
    rajesh: '019a4c00-0003-7000-8000-000000000001',
    priya: '019a4c00-0003-7000-8000-000000000002',
    amit: '019a4c00-0003-7000-8000-000000000003',
    ravi: '019a4c00-0003-7000-8000-000000000004',
    sanjay: '019a4c00-0003-7000-8000-000000000005',
    mohan: '019a4c00-0003-7000-8000-000000000006',
    deepak: '019a4c00-0003-7000-8000-000000000007',
    kiran: '019a4c00-0003-7000-8000-000000000008',
  },
} as const;

export interface SampleCompany {
  id: string;
  code: string;
  name: string;
  gstin: string;
  orderPrefix: string;
}
export interface SamplePlant {
  id: string;
  companyId: string;
  name: string;
  location: string;
}
export interface SampleUser {
  id: string;
  name: string;
  mobile: string;
  role: Role;
  plantIds: string[];
  /** `invited` = has never signed in. */
  status: 'active' | 'invited';
}
export interface SampleWorld {
  ids: typeof ids;
  tenant: { id: string; name: string };
  companies: SampleCompany[];
  plants: SamplePlant[];
  users: SampleUser[];
}

const c = ids.companies;
const p = ids.plants;
const u = ids.users;

export const SAMPLE_WORLD: SampleWorld = {
  ids,
  tenant: { id: ids.tenant, name: 'Agrawal Group' },
  companies: [
    {
      id: c.AIP,
      code: 'AIP',
      name: 'Aarav Ispat Pvt Ltd',
      gstin: '22AAJCA4410K1ZQ',
      orderPrefix: 'SO-AIP',
    },
    {
      id: c.VSL,
      code: 'VSL',
      name: 'Vrinda Steels LLP',
      gstin: '22AAKFV2093P1ZC',
      orderPrefix: 'SO-VSL',
    },
    {
      id: c.KRM,
      code: 'KRM',
      name: 'Kalinga Rolling Mills',
      gstin: '22AADFK7781M1Z2',
      orderPrefix: 'SO-KRM',
    },
    {
      id: c.NAP,
      code: 'NAP',
      name: 'Nandan Alloys Pvt Ltd',
      gstin: '22AAHCN6620Q1Z7',
      orderPrefix: 'SO-NAP',
    },
  ],
  plants: [
    { id: p.siltara, companyId: c.AIP, name: 'Siltara', location: 'Raipur' },
    { id: p.urla, companyId: c.VSL, name: 'Urla', location: 'Raipur' },
    { id: p.borai, companyId: c.KRM, name: 'Borai', location: 'Durg' },
    { id: p.tilda, companyId: c.NAP, name: 'Tilda', location: 'Raipur' },
  ],
  users: [
    {
      id: u.rajesh,
      name: 'Rajesh Agrawal',
      mobile: '+919826100012',
      role: 'owner',
      plantIds: [],
      status: 'active',
    },
    {
      id: u.priya,
      name: 'Priya Sharma',
      mobile: '+919826100013',
      role: 'city_staff',
      plantIds: [],
      status: 'active',
    },
    {
      id: u.amit,
      name: 'Amit Verma',
      mobile: '+919425067890',
      role: 'city_staff',
      plantIds: [],
      status: 'active',
    },
    {
      id: u.ravi,
      name: 'Ravi Verma',
      mobile: '+919826100014',
      role: 'supervisor',
      plantIds: [p.siltara],
      status: 'active',
    },
    {
      id: u.sanjay,
      name: 'Sanjay Patel',
      mobile: '+919826100015',
      role: 'supervisor',
      plantIds: [p.borai],
      status: 'active',
    },
    {
      id: u.mohan,
      name: 'Mohan Kurre',
      mobile: '+919826100016',
      role: 'supervisor',
      plantIds: [p.urla],
      status: 'active',
    },
    {
      id: u.deepak,
      name: 'Deepak Sahu',
      mobile: '+919826100017',
      role: 'supervisor',
      plantIds: [p.tilda],
      status: 'invited',
    },
    {
      id: u.kiran,
      name: 'Kiran Rao',
      mobile: '+919826100018',
      role: 'plant_head',
      plantIds: [p.siltara],
      status: 'active',
    },
  ],
};
