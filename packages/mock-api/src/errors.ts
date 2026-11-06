import type { ApiErrorBody, ErrorCode } from '@tonnage/shared';

const MESSAGES: Record<ErrorCode, string> = {
  VALIDATION: 'Some fields are not valid',
  UNAUTHENTICATED: 'Please sign in again',
  FORBIDDEN: "You don't have access",
  NOT_FOUND: 'Not found',
  STALE: 'This record was changed by someone else',
  OTP_INVALID: 'That code is not right',
  OTP_EXPIRED: 'That code has expired',
  OTP_LOCKED: 'Too many wrong codes. Try again later',
  OTP_RESEND_TOO_SOON: 'Please wait before asking for a new code',
  TENANT_CHOICE_REQUIRED: 'Choose which business to sign in to',
  MOBILE_EXISTS: 'A user with this mobile already exists',
  LAST_OWNER: 'There must be at least one active owner',
  PLANT_RULE: 'Plants do not match the role',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required',
  IDEMPOTENCY_IN_PROGRESS: 'This request is already being processed',
  INTERNAL: 'Something went wrong',
};

/** Thrown by the pipeline and handlers; turned into `{ code, message, details? }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, details?: unknown, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function errorBody(code: ErrorCode, details?: unknown): ApiErrorBody {
  return new ApiError(500, code, details).toBody();
}

export const notFound = () => new ApiError(404, 'NOT_FOUND');
export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED');
export const stale = () => new ApiError(409, 'STALE');

export interface IssueDetail {
  path: (string | number)[];
  message: string;
}

export function validationError(details: IssueDetail[]): ApiError {
  return new ApiError(422, 'VALIDATION', details);
}

/** zod issues → `{ path, message }[]` (symbol path keys stringified). */
export function issueDetails(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): IssueDetail[] {
  return issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    message: i.message,
  }));
}
