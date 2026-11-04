/** Indian digit grouping for a string of digits: last 3, then groups of 2 (12,48,640). */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const head = intDigits.slice(0, -3);
  const tail = intDigits.slice(-3);
  const groups: string[] = [];
  for (let end = head.length; end > 0; end -= 2) {
    groups.unshift(head.slice(Math.max(0, end - 2), end));
  }
  return `${groups.join(',')},${tail}`;
}

const MINUS = '−';
const LAKH = 100_000;
const CRORE = 10_000_000;

function withSign(n: number, body: string): string {
  return n < 0 ? `${MINUS}${body}` : body;
}

/** Integer rupees with Indian grouping: 1,46,000 with rupee sign; negatives use U+2212. */
export function formatRupees(n: number): string {
  return withSign(n, `₹${groupIndian(String(Math.abs(Math.trunc(n))))}`);
}

function scaled(abs: number, unit: number): string {
  // Round half up to 2 decimals using integer maths.
  const hundredths = Math.floor((abs * 200 + unit) / (2 * unit));
  const whole = Math.floor(hundredths / 100);
  const frac = String(hundredths % 100).padStart(2, '0');
  return `${groupIndian(String(whole))}.${frac}`;
}

/** Compact rupees: 55.80 L, 1.46 Cr; below 1 lakh the full amount. */
export function formatRupeesShort(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  if (abs >= CRORE) return withSign(n, `₹${scaled(abs, CRORE)} Cr`);
  if (abs >= LAKH) {
    // Just under 1 Cr rounds up to 100.00 L; show as 1.00 Cr instead.
    if (abs * 200 + LAKH >= 2 * LAKH * 10_000) return withSign(n, `₹${scaled(abs, CRORE)} Cr`);
    return withSign(n, `₹${scaled(abs, LAKH)} L`);
  }
  return formatRupees(n);
}
