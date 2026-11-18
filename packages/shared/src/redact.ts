import type { Role } from './roles.ts';

export const MONEY_KEYS: ReadonlySet<string> = new Set([
  'rate', 'basicRate', 'basicRateSnapshot', 'conversion', 'conversionSnapshot', 'conversionPerMt',
  'overpricePerMt', 'commissionPerMt', 'commissionPerMtSnapshot', 'defaultCommissionPerMt',
  'valueRupees', 'lineValue', 'orderValue', 'amount', 'amountRupees', 'due', 'earned', 'paid',
  'tdsRupees', 'billedRate', 'estimatedValue', 'brokerEarningEstimate', 'earningRupees', 'breakdown',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!MONEY_KEYS.has(k)) out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/** Omits money keys at any depth for plant_head and supervisor. Never mutates input. */
export function redactForRole(role: Role, payload: unknown): unknown {
  return role === 'plant_head' || role === 'supervisor' ? strip(payload) : payload;
}
