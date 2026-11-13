/** GST state codes (first two characters of a GSTIN). */
export const GSTIN_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Upper case, no spaces: what people type ("27aakfs 1234l1z5") becomes the stored form. */
export function normalizeGstin(v: string): string {
  return v.replace(/\s+/g, '').toUpperCase();
}

/** The mod-36 check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = ALPHABET.indexOf(first14.charAt(i));
    if (v < 0) throw new RangeError(`not a GSTIN character: ${first14.charAt(i)}`);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

export type GstinCheck =
  | { ok: false; reason: 'format' | 'state' }
  | { ok: true; state: string; checksumOk: boolean };

/**
 * Offline GSTIN check (no GST portal): shape and state code must be right; a wrong check
 * character is reported (`checksumOk: false`) for the form to warn about, never to block.
 */
export function checkGstin(input: string): GstinCheck {
  const v = normalizeGstin(input);
  if (!FORMAT.test(v)) return { ok: false, reason: 'format' };
  const state = GSTIN_STATES[v.slice(0, 2)];
  if (!state) return { ok: false, reason: 'state' };
  return { ok: true, state, checksumOk: gstinCheckChar(v.slice(0, 14)) === v.charAt(14) };
}
