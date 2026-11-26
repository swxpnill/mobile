import { ERROR_MESSAGES, type ApiErrorBody, type ErrorCode } from '@tonnage/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RETRYABLE_PG_CODES, pgCode } from '../db/pg-error.ts';
import { badBodyReason } from './body-parser.ts';

/** Thrown by handlers; turned into `{ code, message, details? }` (same signature as the mock's `ApiError`). */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, details?: unknown) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AppError';
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

export interface IssueDetail {
  path: (string | number)[];
  message: string;
}

/** zod issues to `{ path, message }[]` (symbol path keys stringified). */
export function issueDetails(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): IssueDetail[] {
  return issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    message: i.message,
  }));
}

/** A request failed schema validation; carries the issues with their real paths. */
export class ValidationFailure extends Error {
  readonly details: IssueDetail[];
  constructor(details: IssueDetail[]) {
    super('Request validation failed');
    this.name = 'ValidationFailure';
    this.details = details;
  }
}

/** Fastify validator compiler for zod schemas that keeps issue paths intact (numbers stay numbers). */
export const zodValidatorCompiler = ({ schema }: { schema: unknown }) => {
  return (data: unknown) => {
    const bad = badBodyReason(data);
    if (bad !== null) return { error: new ValidationFailure([{ path: [], message: bad }]) };
    const result = z.safeParse(schema as z.ZodType, data);
    if (result.success) return { value: result.data };
    return { error: new ValidationFailure(issueDetails(result.error.issues)) };
  };
};

/** Seconds a client is asked to wait before sending a BUSY request again. */
const BUSY_RETRY_AFTER_S = '1';

function clientErrorFor(status: number): AppError {
  switch (status) {
    case 401:
      return new AppError(401, 'UNAUTHENTICATED');
    case 403:
      return new AppError(403, 'FORBIDDEN');
    case 404:
      return new AppError(404, 'NOT_FOUND');
    case 429:
      return new AppError(429, 'RATE_LIMITED');
    default:
      return new AppError(422, 'VALIDATION', [{ path: [], message: 'Invalid request' }]);
  }
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ValidationFailure) return new AppError(422, 'VALIDATION', error.details);
  const fe = error as Partial<FastifyError> | null;
  // Fastify's own request errors (malformed JSON, wrong content type, oversized body).
  if (
    fe &&
    typeof fe.code === 'string' &&
    fe.code.startsWith('FST_ERR_') &&
    typeof fe.statusCode === 'number' &&
    fe.statusCode >= 400 &&
    fe.statusCode < 500
  ) {
    return new AppError(422, 'VALIDATION', [{ path: [], message: fe.message ?? 'Invalid request' }]);
  }
  // Any other 4xx a plugin throws (e.g. @fastify/rate-limit's 429) keeps its meaning by status. Its
  // message is not ours to show, so none of it reaches the client.
  if (fe && typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    return clientErrorFor(fe.statusCode);
  }
  // Lock contention (deadlock, serialization failure, lock timeout): the client may send it again.
  const code = pgCode(error);
  if (code !== null && RETRYABLE_PG_CODES.has(code)) return new AppError(503, 'BUSY');
  return new AppError(500, 'INTERNAL');
}

/** Maps every failure to the contract's `{ code, message, details? }` and logs unexpected ones. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const appError = toAppError(error);
    if (appError.code === 'BUSY') {
      // Expected under contention: a warning with the SQLSTATE, and a hint to send it again shortly.
      request.log.warn({ pgCode: pgCode(error), requestId: request.id }, 'database busy');
      void reply.header('retry-after', BUSY_RETRY_AFTER_S);
    } else if (appError.status >= 500) {
      // The stack goes to the log (with the request id), never to the client.
      request.log.error({ err: error, requestId: request.id }, 'unhandled error');
    }
    return reply.status(appError.status).send(appError.toBody());
  });
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(new AppError(404, 'NOT_FOUND').toBody());
  });
}
