import type { PricingMethod } from '../settings.ts';

function assertNonNegativeInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${n}`);
  }
}

/**
 * The only rounding in the app (§5.4): integer division rounded half up, for non-negative
 * integers. `floor((2n + d) / 2d)` stays exact for every value the schemas allow
 * (≤ 10,000,000 kg × ≤ 10,000,000 ₹/MT = 1e14, well under 2^53).
 */
export function roundHalfUp(numerator: number, denominator: number): number {
  assertNonNegativeInt(numerator, 'numerator');
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError(`denominator must be a positive safe integer, got ${denominator}`);
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export interface LineRateInput {
  method: PricingMethod;
  /** Order-level basic rate, ₹/MT; required for `basic_conversion`. */
  basicRate: number | null;
  /** The product's conversion, ₹/MT (snapshotted on the line). */
  conversionPerMt: number;
  /** A rate the user typed, ₹/MT; required for `direct`, an override for `basic_conversion`. */
  typedRate: number | null;
}

/**
 * The line's rate, ₹/MT, before overprice and GST (§5.4). Under `basic_conversion` the rate is
 * basic + conversion; a typed rate that differs from that is an override (`rateEdited`).
 */
export function lineRate(input: LineRateInput): { rate: number; rateEdited: boolean } {
  if (input.method === 'direct') {
    if (input.typedRate === null) throw new RangeError('direct pricing needs a typed rate');
    return { rate: input.typedRate, rateEdited: false };
  }
  if (input.basicRate === null) throw new RangeError('basic + conversion pricing needs a basic rate');
  const derived = input.basicRate + input.conversionPerMt;
  if (input.typedRate === null || input.typedRate === derived) {
    return { rate: derived, rateEdited: false };
  }
  return { rate: input.typedRate, rateEdited: true };
}

/** What the customer is charged per MT: rate plus the broker's overprice. */
export function billedRate(rate: number, overpricePerMt: number): number {
  return rate + overpricePerMt;
}

/** Whole rupees for a line: ordered kg × billed ₹/MT ÷ 1000, rounded once. An estimate (§5.4). */
export function lineValue(orderedKg: number, billedRatePerMt: number): number {
  return roundHalfUp(orderedKg * billedRatePerMt, 1000);
}

export interface BrokerEarningEstimate {
  commission: number;
  overprice: number;
  total: number;
  commissionKg: number;
  overpriceKg: number;
}

/**
 * Broker earning shown on Review: commission on every kg, overprice only on lines that carry
 * one, each part rounded once over the whole order. The real earning is fixed per truck at
 * dispatch on net weight (§5.4); this is only the booking-time estimate.
 */
export function brokerEarningEstimate(
  lines: readonly { orderedKg: number; overpricePerMt: number }[],
  commissionPerMt: number,
): BrokerEarningEstimate {
  let commissionKg = 0;
  let overpriceKg = 0;
  let overpriceSum = 0;
  for (const l of lines) {
    commissionKg += l.orderedKg;
    if (l.overpricePerMt > 0) {
      overpriceKg += l.orderedKg;
      overpriceSum += l.orderedKg * l.overpricePerMt;
    }
  }
  const commission = roundHalfUp(commissionKg * commissionPerMt, 1000);
  const overprice = roundHalfUp(overpriceSum, 1000);
  return { commission, overprice, total: commission + overprice, commissionKg, overpriceKg };
}
