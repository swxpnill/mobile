import { ERROR_MESSAGES, type ApiErrorBody, type ErrorCode } from '@tonnage/shared';

/** The user-facing message for an error code (also used for sync rejections, which are not thrown). */
export function errorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}

/** Thrown by the pipeline and handlers; turned into `{ code, message, details? }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, details?: unknown, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
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
