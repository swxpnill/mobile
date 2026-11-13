const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** Calendar date in Asia/Kolkata (fixed +05:30, no DST), without depending on Intl data. */
export function istDateParts(at: string | number): { year: number; month: number; day: number } {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new RangeError(`not a date: ${String(at)}`);
  const d = new Date(ms + IST_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Indian financial year, 1 April – 31 March IST, as "2026-27". */
export function financialYear(at: string | number): string {
  const { year, month } = istDateParts(at);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const MIN_SEQ_WIDTH = 4;

/**
 * Applies the tenant's `orderNumberFormat` (default `SO-YYMM-0001`): `YYMM` becomes the IST
 * year and month, the last run of digits is the sequence slot, zero-padded to its width (at
 * least 4) and allowed to grow past it. Numbers are issued only by the server (§5.3).
 */
export function formatOrderNumber(format: string, at: string | number, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`sequence must be ≥ 1, got ${seq}`);
  const slot = /\d+(?!.*\d)/.exec(format);
  if (!slot) throw new RangeError(`order number format has no number slot: ${format}`);
  const width = Math.max(MIN_SEQ_WIDTH, slot[0].length);
  const { year, month } = istDateParts(at);
  const yymm = `${String(year % 100).padStart(2, '0')}${String(month).padStart(2, '0')}`;
  const numbered =
    format.slice(0, slot.index) + String(seq).padStart(width, '0') + format.slice(slot.index + slot[0].length);
  return numbered.replace('YYMM', yymm);
}

/** 0 → A, 25 → Z, 26 → AA (bijective base 26), in the order companies were added. */
export function subOrderSuffix(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`bad index ${index}`);
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function subOrderNumber(orderNumber: string, suffix: string): string {
  return `${orderNumber}-${suffix}`;
}

/** Loading slip number `LS-<company code>-YYMM-0001` (IST year and month), issued only by the server (§5.3). */
export function formatLoadingSlip(companyCode: string, at: string | number, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`sequence must be ≥ 1, got ${seq}`);
  const { year, month } = istDateParts(at);
  const yymm = `${String(year % 100).padStart(2, '0')}${String(month).padStart(2, '0')}`;
  return `LS-${companyCode}-${yymm}-${String(seq).padStart(MIN_SEQ_WIDTH, '0')}`;
}
