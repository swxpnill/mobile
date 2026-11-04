import { groupIndian } from './format.ts';

export type UnitBasis = 'mt' | 'kg';

export type ParseResult =
  { ok: true; value: number } | { ok: false; error: 'EMPTY' | 'INVALID' | 'TOO_MANY_DECIMALS' };

export function unitLabel(basis: UnitBasis): 'MT' | 'kg' {
  return basis === 'mt' ? 'MT' : 'kg';
}

/** Grouped integer part plus a fixed 3-digit fraction of a value stored in thousandths. */
function formatThousandths(n: number): string {
  const whole = Math.trunc(n / 1000);
  const frac = String(n % 1000).padStart(3, '0');
  return `${groupIndian(String(whole))}.${frac}`;
}

/** Parses a non-negative decimal string; `decimals` is the max fraction digits allowed. */
function parseScaled(input: string, decimals: 0 | 3): ParseResult {
  const cleaned = input.trim().replace(/[,\s]/g, '');
  if (cleaned === '') return { ok: false, error: 'EMPTY' };
  if (!/^\d*(\.\d*)?$/.test(cleaned) || !/\d/.test(cleaned)) {
    return { ok: false, error: 'INVALID' };
  }
  const [wholeStr = '', fracStr = ''] = cleaned.split('.');
  if (fracStr.length > decimals) return { ok: false, error: 'TOO_MANY_DECIMALS' };
  const whole = Number(wholeStr || '0');
  if (decimals === 0) return { ok: true, value: whole };
  return { ok: true, value: whole * 1000 + Number(fracStr.padEnd(3, '0')) };
}

/** Quantity is stored as integer kg. MT shows 3 decimals, kg whole numbers. */
export function toDisplayQty(kg: number, basis: UnitBasis, opts?: { withUnit?: boolean }): string {
  const text = basis === 'mt' ? formatThousandths(kg) : groupIndian(String(kg));
  return opts?.withUnit ? `${text} ${unitLabel(basis)}` : text;
}

/** Returns kg. */
export function parseQtyInput(input: string, basis: UnitBasis): ParseResult {
  return parseScaled(input, basis === 'mt' ? 3 : 0);
}

/** Rate is stored as whole rupees per MT. kg basis shows rupees per kg to 3 decimals. */
export function toDisplayRate(
  ratePerMt: number,
  basis: UnitBasis,
  opts?: { withUnit?: boolean },
): string {
  const text = basis === 'mt' ? groupIndian(String(ratePerMt)) : formatThousandths(ratePerMt);
  return `₹${text}${opts?.withUnit ? ` / ${unitLabel(basis)}` : ''}`;
}

/** Returns whole rupees per MT. */
export function parseRateInput(input: string, basis: UnitBasis): ParseResult {
  return parseScaled(input, basis === 'mt' ? 0 : 3);
}
