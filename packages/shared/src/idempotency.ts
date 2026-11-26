/**
 * The `Idempotency-Key` header's rule, the same for the mock and the API: 1–128 characters of
 * letters, digits and `_ . : -`. Anything else is `422 VALIDATION` at `['idempotency-key']`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const IDEMPOTENCY_KEY_MESSAGE =
  'Use 1 to 128 letters, digits or the characters _ . : -';

export function isIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}
