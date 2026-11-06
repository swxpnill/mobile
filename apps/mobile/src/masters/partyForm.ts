import {
  type Party,
  type PartyBody,
  type PartyType,
  type UnitBasis,
  parseRateInput,
  partyBodySchema,
  toDisplayRate,
} from '@tonnage/shared';

/** Stable list keys for rows that have no server id yet. */
let seq = 0;
const nextKey = () => `k${++seq}`;

export interface NumberDraft {
  key: string;
  id?: string;
  number: string;
  label: string;
  whatsapp: boolean;
}
export interface ContactDraft {
  key: string;
  id?: string;
  name: string;
  roleLabel: string;
  numbers: NumberDraft[];
}
export interface AddressDraft {
  key: string;
  id?: string;
  label: string;
  address: string;
  isDefault: boolean;
}
export interface PartyDraft {
  type: PartyType;
  name: string;
  gstin: string;
  city: string;
  /** As typed, in the person's rate unit (₹/MT or ₹/kg). */
  commission: string;
  paymentTermsText: string;
  isSelfTransporter: boolean;
  contacts: ContactDraft[];
  billTo: { id?: string; address: string };
  shipTo: AddressDraft[];
  active: boolean;
}

export const ROLE_CHOICES = ['Owner', 'Accounts', 'Purchase', 'Site'] as const;
export const MAX_NUMBERS = 5;
export const MAX_CONTACTS = 10;

export const newNumber = (label = 'Mobile'): NumberDraft => ({ key: nextKey(), number: '', label, whatsapp: label === 'Mobile' });
export const newContact = (): ContactDraft => ({ key: nextKey(), name: '', roleLabel: 'Owner', numbers: [newNumber()] });
export const newShipTo = (isDefault: boolean): AddressDraft => ({ key: nextKey(), label: '', address: '', isDefault });

export function emptyDraft(type: PartyType): PartyDraft {
  return {
    type,
    name: '',
    gstin: '',
    city: '',
    commission: '',
    paymentTermsText: '',
    isSelfTransporter: false,
    contacts: [newContact()],
    billTo: { address: '' },
    shipTo: type === 'customer' ? [newShipTo(true)] : [],
    active: true,
  };
}

/** "98260 12345" style for editing (the stored form is +91XXXXXXXXXX). */
const editableNumber = (stored: string) => {
  const d = stored.replace(/^\+91/, '');
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
};

export function draftFromParty(p: Party, basis: UnitBasis): PartyDraft {
  const bill = p.addresses.find((a) => a.kind === 'bill_to');
  return {
    type: p.type,
    name: p.name,
    gstin: p.gstin ?? '',
    city: p.city,
    commission:
      p.defaultCommissionPerMt === null || p.defaultCommissionPerMt === undefined
        ? ''
        : toDisplayRate(p.defaultCommissionPerMt, basis).replace('₹', '').replace(/,/g, ''),
    paymentTermsText: p.paymentTermsText,
    isSelfTransporter: p.isSelfTransporter,
    contacts: p.contacts.map((c) => ({
      key: nextKey(),
      id: c.id,
      name: c.name,
      roleLabel: c.roleLabel,
      numbers: c.numbers.map((n) => ({ key: nextKey(), id: n.id, number: editableNumber(n.number), label: n.label, whatsapp: n.whatsapp })),
    })),
    billTo: bill ? { id: bill.id, address: bill.address } : { address: '' },
    shipTo: p.addresses
      .filter((a) => a.kind === 'ship_to')
      .map((a) => ({ key: nextKey(), id: a.id, label: a.label, address: a.address, isDefault: a.isDefault })),
    active: p.active,
  };
}

/** Field errors keyed by dotted path ("contacts.0.numbers.1.number", "gstin", "addresses"). */
export type FormErrors = Record<string, string>;

/**
 * The request body for a draft, validated with the same schema the server uses, so the form and
 * the API refuse exactly the same things. Errors are keyed by the path the screen shows them at.
 */
export function partyBodyFrom(
  d: PartyDraft,
  basis: UnitBasis,
): { ok: true; body: PartyBody } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  let commission: number | null = null;
  if (d.type === 'broker' && d.commission.trim() !== '') {
    const r = parseRateInput(d.commission, basis);
    if (r.ok) commission = r.value;
    else errors.defaultCommissionPerMt = r.error === 'TOO_MANY_DECIMALS' ? 'Up to 3 decimals' : 'Enter a number';
  }
  const addresses = [
    ...(d.type === 'customer' && d.billTo.address.trim() !== ''
      ? [{ ...(d.billTo.id ? { id: d.billTo.id } : {}), kind: 'bill_to' as const, label: 'Bill to', address: d.billTo.address, isDefault: true }]
      : []),
    ...(d.type === 'customer'
      ? d.shipTo.map((a) => ({ ...(a.id ? { id: a.id } : {}), kind: 'ship_to' as const, label: a.label, address: a.address, isDefault: a.isDefault }))
      : []),
  ];
  const raw = {
    type: d.type,
    name: d.name,
    gstin: d.gstin.trim() === '' ? null : d.gstin,
    city: d.city,
    defaultCommissionPerMt: commission,
    paymentTermsText: d.paymentTermsText,
    isSelfTransporter: d.isSelfTransporter,
    contacts: d.contacts.map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      name: c.name,
      roleLabel: c.roleLabel,
      numbers: c.numbers.map((n) => ({ ...(n.id ? { id: n.id } : {}), number: n.number, label: n.label, whatsapp: n.whatsapp })),
    })),
    addresses,
  };
  const parsed = partyBodySchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = pathKey(issue.path, d);
      errors[key] ??= friendly(key, issue.message);
    }
  }
  if (d.type === 'customer' && d.billTo.address.trim() === '') errors.billTo = 'Enter the bill-to address';
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, body: parsed.data };
}

/** Schema paths point into `addresses` (bill-to first); the screen shows ship-to rows separately. */
function pathKey(path: readonly PropertyKey[], d: PartyDraft): string {
  if (path[0] === 'addresses' && typeof path[1] === 'number') {
    const hasBill = d.type === 'customer' && d.billTo.address.trim() !== '';
    const i = path[1] - (hasBill ? 1 : 0);
    if (i < 0) return 'billTo';
    return ['shipTo', i, ...path.slice(2)].join('.');
  }
  return path.map(String).join('.');
}

function friendly(key: string, message: string): string {
  if (key.endsWith('.name') || key === 'name') return message.startsWith('Too small') ? 'Enter a name' : message;
  if (key === 'city') return 'Enter the city';
  if (key.endsWith('.address')) return 'Enter the address';
  return message.startsWith('Too small') ? 'Required' : message;
}
