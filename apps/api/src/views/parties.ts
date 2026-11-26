import type { Party, PartySummary } from '@tonnage/shared';
import type { contactNumbers, parties, partyAddresses, partyContacts } from '../db/schema/index.ts';

export type PartyRow = typeof parties.$inferSelect;
export type ContactRow = typeof partyContacts.$inferSelect;
export type NumberRow = typeof contactNumbers.$inferSelect;
export type AddressRow = typeof partyAddresses.$inferSelect;

/** A party with its children, each list in `position` order. */
export interface PartyGraph {
  party: PartyRow;
  contacts: (ContactRow & { numbers: NumberRow[] })[];
  addresses: AddressRow[];
}

/** Order figures per party (customer or broker side). */
export interface PartyStats {
  openOrders: number;
  pendingKg: number;
  fyDispatchedKg: number;
}

/** A transporter's truck figures (GET and PATCH only, as in the mock). */
export type TransporterTrips = Pick<
  NonNullable<Party['stats']>,
  'tripsThisMonth' | 'vehiclesSeen' | 'recentVehicles'
>;

export const NO_STATS: PartyStats = { openOrders: 0, pendingKg: 0, fyDispatchedKg: 0 };

/** The graph as `partySchema` (no tenant id, positions or timestamps). */
export function toParty(g: PartyGraph, stats: PartyStats = NO_STATS, trips?: TransporterTrips): Party {
  const p = g.party;
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    gstin: p.gstin,
    city: p.city,
    defaultCommissionPerMt: p.defaultCommissionPerMt,
    paymentTermsText: p.paymentTermsText,
    isSelfTransporter: p.isSelfTransporter,
    contacts: g.contacts.map((c) => ({
      id: c.id,
      name: c.name,
      roleLabel: c.roleLabel,
      numbers: c.numbers.map((n) => ({ id: n.id, number: n.number, label: n.label, whatsapp: n.whatsapp })),
    })),
    addresses: g.addresses.map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      address: a.address,
      isDefault: a.isDefault,
    })),
    active: p.active,
    version: p.version,
    stats: { ...stats, ...trips },
  };
}

/** A list row as `partySummarySchema`; `people` and `numbers` are counted by the list query. */
export function toPartySummary(
  p: PartyRow,
  counts: { people: number; numbers: number },
  stats: PartyStats = NO_STATS,
): PartySummary {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    city: p.city,
    gstin: p.gstin,
    active: p.active,
    people: counts.people,
    numbers: counts.numbers,
    pendingKg: stats.pendingKg,
    defaultCommissionPerMt: p.defaultCommissionPerMt,
  };
}
