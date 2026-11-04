export const ERROR_CODES = [
  'VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'STALE', 'OTP_INVALID', 'OTP_EXPIRED',
  'OTP_LOCKED', 'OTP_RESEND_TOO_SOON', 'TENANT_CHOICE_REQUIRED', 'MOBILE_EXISTS', 'LAST_OWNER',
  'PLANT_RULE', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_IN_PROGRESS', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
