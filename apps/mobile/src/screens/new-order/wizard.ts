import {
  type BrokerEarningEstimate,
  type CreateOrderBody,
  type Length,
  type Order,
  type OrderType,
  type PricingMethod,
  type Product,
  type UnitBasis,
  type UpdateOrderBody,
  billedRate,
  brokerEarningEstimate,
  lineRate,
  lineValue,
  parseQtyInput,
  parseRateInput,
  toDisplayQty,
  toDisplayRate,
} from '@tonnage/shared';

/**
 * The new-order wizard's whole state, as typed. Quantities and rates are strings in the person's
 * unit basis until the body is built; drafts store this object as-is (versioned by `v`).
 */
export interface LineDraft {
  key: string;
  id?: string;
  productId: string;
  length: Length;
  /** Quantity as typed (MT or kg). */
  qty: string;
  /** Rate as typed (₹/MT or ₹/kg); empty = basic + conversion. */
  rate: string;
  /** Broker overprice as typed; empty = none. */
  overprice: string;
}
export interface SubDraft {
  id?: string;
  companyId: string;
  lines: LineDraft[];
}
export interface WizardState {
  v: 1;
  mode: 'create' | 'edit';
  orderId?: string;
  orderVersion?: number;
  step: 1 | 2 | 3;
  type: OrderType;
  customerId: string | null;
  brokerId: string | null;
  /** Commission as typed (₹/MT or ₹/kg). */
  commission: string;
  billToId: string | null;
  shipToId: string | null;
  pricingMethod: PricingMethod;
  basicRate: string;
  subOrders: SubDraft[];
  notify: { customer: boolean; broker: boolean };
}

let seq = 0;
export const newLine = (productId: string): LineDraft => ({
  key: `l${Date.now().toString(36)}${++seq}`,
  productId,
  length: { value: 12, unit: 'm' },
  qty: '',
  rate: '',
  overprice: '',
});

export function emptyWizard(pricing: PricingMethod): WizardState {
  return {
    v: 1,
    mode: 'create',
    step: 1,
    type: 'customer_broker',
    customerId: null,
    brokerId: null,
    commission: '',
    billToId: null,
    shipToId: null,
    pricingMethod: pricing,
    basicRate: '',
    subOrders: [],
    notify: { customer: true, broker: true },
  };
}

export const hasCustomer = (t: OrderType) => t !== 'broker_only';
export const hasBroker = (t: OrderType) => t !== 'customer';

/** Why step 1 cannot continue, or null when it can. */
export function partiesProblem(s: WizardState): string | null {
  if (hasCustomer(s.type)) {
    if (!s.customerId) return 'Choose the customer';
    if (!s.billToId) return 'Choose the bill-to address';
    if (!s.shipToId) return 'Choose where to ship';
  }
  if (hasBroker(s.type)) {
    if (!s.brokerId) return 'Choose the broker';
    if (s.commission.trim() === '') return 'Enter the broker commission';
  }
  return null;
}

/** Why step 2 cannot continue, or null. */
export function itemsProblem(s: WizardState): string | null {
  if (s.subOrders.length === 0 || s.subOrders.every((x) => x.lines.length === 0)) return 'Add at least one line';
  if (s.pricingMethod === 'basic_conversion' && s.basicRate.trim() === '') return 'Enter the basic rate';
  return null;
}

export type BuildResult<B> = { ok: true; body: B } | { ok: false; errors: Record<string, string> };

const decimalsMsg = 'Up to 3 decimals';

function parseRate(v: string, basis: UnitBasis): number | 'bad' | 'decimals' {
  const r = parseRateInput(v, basis);
  return r.ok ? r.value : r.error === 'TOO_MANY_DECIMALS' ? 'decimals' : 'bad';
}

/** Parses every typed value; errors keyed by the field the screen marks. */
function build(s: WizardState, basis: UnitBasis): BuildResult<Omit<CreateOrderBody, 'draftId'> & { subOrders: (CreateOrderBody['subOrders'][number] & { id?: string })[] }> {
  const errors: Record<string, string> = {};
  const rateOrNull = (v: string, key: string, required: string | null): number | null => {
    if (v.trim() === '') {
      if (required) errors[key] = required;
      return null;
    }
    const r = parseRate(v, basis);
    if (r === 'bad') errors[key] = 'Enter a number';
    else if (r === 'decimals') errors[key] = decimalsMsg;
    else return r;
    return null;
  };
  const commission = hasBroker(s.type) ? rateOrNull(s.commission, 'commission', 'Enter the broker commission') : null;
  const basicRate = s.pricingMethod === 'basic_conversion' ? rateOrNull(s.basicRate, 'basicRate', 'Enter the basic rate') : null;
  const subOrders = s.subOrders
    .filter((x) => x.lines.length > 0)
    .map((sub, si) => ({
      ...(sub.id ? { id: sub.id } : {}),
      companyId: sub.companyId,
      lines: sub.lines.map((l, li) => {
        const k = `subOrders.${si}.lines.${li}`;
        const q = parseQtyInput(l.qty, basis);
        let orderedKg = 0;
        if (!q.ok) errors[`${k}.qty`] = q.error === 'EMPTY' ? 'Enter the quantity' : q.error === 'TOO_MANY_DECIMALS' ? decimalsMsg : 'Enter a number';
        else if (q.value <= 0) errors[`${k}.qty`] = 'Enter the quantity';
        else orderedKg = q.value;
        const typedRate = rateOrNull(l.rate, `${k}.rate`, s.pricingMethod === 'direct' ? 'Enter the rate' : null);
        const overprice = hasBroker(s.type) ? rateOrNull(l.overprice, `${k}.overprice`, null) : null;
        return {
          ...(l.id ? { id: l.id } : {}),
          productId: l.productId,
          length: { ...l.length },
          orderedKg,
          typedRate,
          overpricePerMt: overprice ?? 0,
        };
      }),
    }));
  if (subOrders.length === 0) errors.lines = 'Add at least one line';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      type: s.type,
      customerId: hasCustomer(s.type) ? s.customerId : null,
      brokerId: hasBroker(s.type) ? s.brokerId : null,
      commissionPerMt: commission,
      billToId: hasCustomer(s.type) ? s.billToId : null,
      shipToId: hasCustomer(s.type) ? s.shipToId : null,
      pricingMethod: s.pricingMethod,
      basicRate,
      subOrders,
      notify: { customer: hasCustomer(s.type) && s.notify.customer, broker: hasBroker(s.type) && s.notify.broker },
    },
  };
}

export function toCreateBody(s: WizardState, basis: UnitBasis, draftId: string | null): BuildResult<CreateOrderBody> {
  const r = build(s, basis);
  if (!r.ok) return r;
  // New orders carry no sub-order ids (those are only for editing).
  const subOrders = r.body.subOrders.map((x) => ({ companyId: x.companyId, lines: x.lines }));
  return { ok: true, body: { draftId, ...r.body, subOrders } as CreateOrderBody };
}

export function toUpdateBody(s: WizardState, basis: UnitBasis): BuildResult<UpdateOrderBody> {
  const r = build(s, basis);
  if (!r.ok) return r;
  return { ok: true, body: { version: s.orderVersion ?? 0, ...r.body } as UpdateOrderBody };
}

const asText = (n: number | null | undefined, basis: UnitBasis) =>
  n === null || n === undefined ? '' : toDisplayRate(n, basis).replace('₹', '').replace(/,/g, '');

/** An existing order in edit mode (opens on Items; lines keep ids for the server's diff). */
export function fromOrder(o: Order, basis: UnitBasis): WizardState {
  return {
    v: 1,
    mode: 'edit',
    orderId: o.id,
    orderVersion: o.version,
    step: 2,
    type: o.type,
    customerId: o.customer?.id ?? null,
    brokerId: o.broker?.id ?? null,
    commission: asText(o.commissionPerMtSnapshot, basis),
    billToId: o.billTo?.id ?? null,
    shipToId: o.shipTo?.id ?? null,
    pricingMethod: o.pricingMethod,
    basicRate: asText(o.basicRate, basis),
    notify: { ...o.notify },
    subOrders: o.subOrders.map((s) => ({
      id: s.id,
      companyId: s.companyId,
      lines: s.lines.map((l) => ({
        key: l.id,
        id: l.id,
        productId: l.productId,
        length: { ...l.length },
        qty: toDisplayQty(l.orderedKg, basis).replace(/,/g, ''),
        rate: o.pricingMethod === 'direct' || l.rateEdited ? asText(l.rate, basis) : '',
        overprice: l.overpricePerMt ? asText(l.overpricePerMt, basis) : '',
      })),
    })),
  };
}

export const toPayload = (s: WizardState): Record<string, unknown> => JSON.parse(JSON.stringify(s)) as Record<string, unknown>;

/** A saved draft back into the wizard; null for anything that is not one of ours. */
export function fromPayload(p: Record<string, unknown>): WizardState | null {
  if (p.v !== 1 || !Array.isArray(p.subOrders) || typeof p.type !== 'string') return null;
  return p as unknown as WizardState;
}

/**
 * Duplicate makes a draft whose payload is a create body (server shape); turn it into wizard
 * state so it opens like any draft.
 */
export function fromCreateBody(b: Record<string, unknown>, basis: UnitBasis): WizardState | null {
  if (!Array.isArray(b.subOrders) || typeof b.type !== 'string') return null;
  const body = b as unknown as CreateOrderBody;
  const s = emptyWizard(body.pricingMethod);
  return {
    ...s,
    type: body.type,
    customerId: body.customerId,
    brokerId: body.brokerId,
    commission: asText(body.commissionPerMt, basis),
    billToId: body.billToId,
    shipToId: body.shipToId,
    basicRate: asText(body.basicRate, basis),
    notify: { ...body.notify },
    subOrders: body.subOrders.map((x) => ({
      companyId: x.companyId,
      lines: x.lines.map((l) => ({
        ...newLine(l.productId),
        length: { ...l.length },
        qty: toDisplayQty(l.orderedKg, basis).replace(/,/g, ''),
        rate: asText(l.typedRate, basis),
        overprice: l.overpricePerMt ? asText(l.overpricePerMt, basis) : '',
      })),
    })),
  };
}

export interface Preview {
  lines: { si: number; li: number; kg: number; rate: number | null; value: number | null }[];
  perSub: { kg: number; value: number }[];
  totalKg: number;
  totalValue: number;
  lineCount: number;
  broker: BrokerEarningEstimate | null;
}

/**
 * What the Review screen shows, with the same rules the server uses (spec §5.4). Lines whose
 * values do not parse yet count as zero; the server's figures win after Create (§8.3).
 */
export function preview(s: WizardState, basis: UnitBasis, products: ReadonlyMap<string, Pick<Product, 'conversionPerMt'>>): Preview {
  const basic = s.pricingMethod === 'basic_conversion' ? parseRate(s.basicRate, basis) : null;
  const out: Preview = { lines: [], perSub: [], totalKg: 0, totalValue: 0, lineCount: 0, broker: null };
  const brokerLines: { orderedKg: number; overpricePerMt: number }[] = [];
  s.subOrders.forEach((sub, si) => {
    const acc = { kg: 0, value: 0 };
    sub.lines.forEach((l, li) => {
      const q = parseQtyInput(l.qty, basis);
      const kg = q.ok ? q.value : 0;
      const typed = l.rate.trim() === '' ? null : parseRate(l.rate, basis);
      const over = l.overprice.trim() === '' || !hasBroker(s.type) ? 0 : parseRate(l.overprice, basis);
      let rate: number | null = null;
      try {
        if (typeof typed !== 'string' && (s.pricingMethod === 'direct' ? typed !== null : typeof basic === 'number')) {
          rate = lineRate({
            method: s.pricingMethod,
            basicRate: typeof basic === 'number' ? basic : null,
            conversionPerMt: products.get(l.productId)?.conversionPerMt ?? 0,
            typedRate: typed,
          }).rate;
        }
      } catch {
        rate = null;
      }
      const overprice = typeof over === 'number' ? over : 0;
      const value = rate === null ? null : lineValue(kg, billedRate(rate, overprice));
      out.lines.push({ si, li, kg, rate, value });
      acc.kg += kg;
      acc.value += value ?? 0;
      out.lineCount += 1;
      brokerLines.push({ orderedKg: kg, overpricePerMt: overprice });
    });
    out.perSub.push(acc);
    out.totalKg += acc.kg;
    out.totalValue += acc.value;
  });
  if (hasBroker(s.type)) {
    const c = parseRate(s.commission, basis);
    out.broker = brokerEarningEstimate(brokerLines, typeof c === 'number' ? c : 0);
  }
  return out;
}
