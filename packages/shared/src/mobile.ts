/** Normalise an Indian mobile number to +91XXXXXXXXXX, or null if invalid. */
export function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let ten: string;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits.startsWith('0')) ten = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) ten = digits.slice(2);
  else return null;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}
