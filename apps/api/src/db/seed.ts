import { DEFAULT_TENANT_SETTINGS, SAMPLE_MASTERS, SAMPLE_WORLD } from '@tonnage/shared';
import { eq } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import type { Db, Tx } from './client.ts';
import {
  companies,
  contactNumbers,
  parties,
  partyAddresses,
  partyContacts,
  plants,
  productCompanies,
  products,
  tenants,
  userPlants,
  users,
} from './schema/index.ts';

/**
 * Inserts the org layer of `SAMPLE_WORLD` (tenant, companies, plants, users, user plants) and the
 * masters of `SAMPLE_MASTERS` (parties with contacts and addresses, products with their companies)
 * with the fixtures' ids, mirroring the mock's `seedState`. Needs the owner connection (RLS would
 * refuse the runtime role). One transaction; each layer is skipped when it is already there.
 * Demo orders are not seeded (plan Ruling 10).
 */
export async function seed(ownerDb: Db, clock: Clock): Promise<{ tenantId: string }> {
  const tenantId = SAMPLE_WORLD.tenant.id;
  const now = new Date(clock.now());

  await ownerDb.transaction(async (tx) => {
    const tenant = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (tenant.length === 0) await seedOrg(tx, tenantId, now);
    // Checked on its own, so a database seeded before B2 (org layer only) gains the masters.
    const firstParty = SAMPLE_MASTERS.parties[0]?.id ?? '';
    const masters = await tx.select({ id: parties.id }).from(parties).where(eq(parties.id, firstParty));
    if (masters.length === 0) await seedMasters(tx, tenantId, now);
  });
  return { tenantId };
}

/** The org layer: tenant, companies, plants, users and their plants. */
async function seedOrg(tx: Tx, tenantId: string, now: Date): Promise<void> {
  const w = SAMPLE_WORLD;
  const stamps = { createdAt: now, updatedAt: now };
  await tx.insert(tenants).values({
    id: tenantId,
    name: w.tenant.name,
    settings: { ...DEFAULT_TENANT_SETTINGS },
    ...stamps,
  });
  await tx.insert(companies).values(
    w.companies.map((c) => ({
      id: c.id,
      tenantId,
      code: c.code,
      name: c.name,
      gstin: c.gstin,
      orderPrefix: c.orderPrefix,
      active: true,
      version: 1,
      ...stamps,
    })),
  );
  await tx.insert(plants).values(
    w.plants.map((p) => ({
      id: p.id,
      tenantId,
      companyId: p.companyId,
      name: p.name,
      location: p.location,
      active: true,
      version: 1,
      ...stamps,
    })),
  );
  await tx.insert(users).values(
    w.users.map((u) => ({
      id: u.id,
      tenantId,
      name: u.name,
      mobile: u.mobile,
      role: u.role,
      active: true,
      version: 1,
      preferences: { unitBasis: 'mt' as const },
      invitedAt: now,
      lastSeenAt: u.status === 'invited' ? null : now,
      ...stamps,
    })),
  );
  const links = w.users.flatMap((u) =>
    u.plantIds.map((plantId) => ({ tenantId, userId: u.id, plantId, ...stamps })),
  );
  if (links.length > 0) await tx.insert(userPlants).values(links);
}

/** `SAMPLE_MASTERS`, as the mock's `seedMasters`: created by the owner, children in fixture order. */
async function seedMasters(tx: Tx, tenantId: string, now: Date): Promise<void> {
  const stamps = { createdAt: now, updatedAt: now };
  const createdBy = SAMPLE_WORLD.ids.users.rajesh;
  const companyIdByCode = new Map(SAMPLE_WORLD.companies.map((c) => [c.code, c.id]));

  await tx.insert(parties).values(
    SAMPLE_MASTERS.parties.map((p) => ({
      id: p.id,
      tenantId,
      type: p.type,
      name: p.name,
      gstin: p.gstin,
      city: p.city,
      defaultCommissionPerMt: p.defaultCommissionPerMt,
      paymentTermsText: p.paymentTermsText,
      isSelfTransporter: p.isSelfTransporter,
      active: true,
      version: 1,
      createdBy,
      ...stamps,
    })),
  );
  const contacts = SAMPLE_MASTERS.parties.flatMap((p) =>
    p.contacts.map((c, position) => ({ party: p, contact: c, position })),
  );
  if (contacts.length > 0) {
    await tx.insert(partyContacts).values(
      contacts.map(({ party, contact, position }) => ({
        id: contact.id,
        tenantId,
        partyId: party.id,
        position,
        name: contact.name,
        roleLabel: contact.roleLabel,
        ...stamps,
      })),
    );
  }
  const numbers = contacts.flatMap(({ party, contact }) =>
    contact.numbers.map((n, position) => ({
      id: n.id,
      tenantId,
      partyId: party.id,
      contactId: contact.id,
      position,
      number: n.number,
      label: n.label,
      whatsapp: n.whatsapp,
      ...stamps,
    })),
  );
  if (numbers.length > 0) await tx.insert(contactNumbers).values(numbers);
  const addresses = SAMPLE_MASTERS.parties.flatMap((p) =>
    p.addresses.map((a, position) => ({
      id: a.id,
      tenantId,
      partyId: p.id,
      position,
      kind: a.kind,
      label: a.label,
      address: a.address,
      isDefault: a.isDefault,
      ...stamps,
    })),
  );
  if (addresses.length > 0) await tx.insert(partyAddresses).values(addresses);

  await tx.insert(products).values(
    SAMPLE_MASTERS.products.map((p) => ({
      id: p.id,
      tenantId,
      category: p.category,
      grade: p.grade,
      sizeLabel: p.sizeLabel,
      conversionPerMt: p.conversionPerMt,
      standardLengths: p.standardLengths.map((l) => ({ ...l })),
      active: true,
      version: 1,
      createdBy,
      ...stamps,
    })),
  );
  const links = SAMPLE_MASTERS.products.flatMap((p) =>
    p.companyCodes.map((code, position) => {
      const companyId = companyIdByCode.get(code);
      if (companyId === undefined) throw new Error(`seed: unknown company code ${code} on product ${p.id}`);
      return { tenantId, productId: p.id, companyId, position, ...stamps };
    }),
  );
  if (links.length > 0) await tx.insert(productCompanies).values(links);
}
