/** A normalised Indian mobile, as the server stores it: +91, then ten digits starting 6–9. */
const INDIAN_MOBILE = /^\+91([6-9]\d{9})$/;

/** `tel:+91…` for a normalised Indian mobile; null for anything else (no broken links). */
export function telLink(mobile: string): string | null {
  return INDIAN_MOBILE.test(mobile) ? `tel:${mobile}` : null;
}

/** `https://wa.me/91…?text=…` for a normalised Indian mobile; null for anything else. */
export function whatsappLink(mobile: string, text: string): string | null {
  const m = INDIAN_MOBILE.exec(mobile);
  return m ? `https://wa.me/91${m[1]}?text=${encodeURIComponent(text)}` : null;
}

/**
 * `tel:` for any saved number, a landline too (Request vehicle Ruling 6): the stored `+91…` form,
 * kept to a leading + and digits. Null when there are no digits to dial.
 */
export function dialLink(number: string): string | null {
  const plus = number.trim().startsWith('+') ? '+' : '';
  const digits = number.replace(/\D/g, '');
  return digits.length >= 6 ? `tel:${plus}${digits}` : null;
}
