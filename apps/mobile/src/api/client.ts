import * as Crypto from 'expo-crypto';
import {
  type ErrorCode,
  type HttpMethod,
  type TransportResponse,
  apiErrorBodySchema,
} from '@tonnage/shared';
import type { ZodType } from 'zod';
import { useSession } from '../auth/session';
import { timed } from './netStatus';
import { getTransport } from './transport';

/** A non-2xx response from the API, with the contract's `{ code, message, details? }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export { REQUEST_TIMEOUT_MS } from './netStatus';

export interface ApiInit<T> {
  method?: HttpMethod;
  body?: unknown;
  /** Adds an `Idempotency-Key`, created once and reused if this call retries. */
  idempotent?: boolean;
  /**
   * A key the caller holds across retries of one submit (see `useSubmitKey`), so a retry after a
   * lost answer replays the first result instead of creating a second record.
   */
  idempotencyKey?: string;
  /** Parses the 2xx body; a mismatch is a bug, not a user error. */
  schema?: ZodType<T>;
  /** Send the access token (default). Public routes such as `/v1/meta` pass `false`. */
  auth?: boolean;
}

/**
 * One API call through the current transport. Adds the access token; on a 401 runs the shared
 * single-flight refresh and retries once. A failed refresh signs the user out; a network failure
 * never does (the phone may simply be offline).
 */
export async function api<T = unknown>(path: string, init: ApiInit<T> = {}): Promise<T> {
  const { method = 'GET', body, idempotent, idempotencyKey, schema, auth = true } = init;
  const key = idempotencyKey ?? (idempotent ? Crypto.randomUUID() : undefined);

  let sentWith: string | undefined;
  const send = async (): Promise<TransportResponse> => {
    const headers: Record<string, string> = {};
    sentWith = useSession.getState().accessToken;
    if (auth && sentWith) headers.authorization = `Bearer ${sentWith}`;
    if (key) headers['idempotency-key'] = key;
    return timed((await getTransport()).request({ method, path, headers, body }));
  };

  const identity = useSession.getState().identity;
  let res = await send();
  // Signed out or switched person while this was out: never resend it as someone else.
  const samePerson = useSession.getState().identity === identity;
  if (res.status === 401 && auth && samePerson && useSession.getState().refreshToken) {
    const current = useSession.getState().accessToken;
    if (current && current !== sentWith) {
      // Another request already refreshed while this one was out: just retry with the new token.
      // Rotating again would waste a rotation and invite the chained-rotation edge (F1.4 review).
      res = await send();
    } else {
      const refreshed = await useSession.getState().refresh(); // shared by concurrent callers
      if (refreshed) res = await send();
    }
  }
  if (res.status < 200 || res.status >= 300) throw toApiError(res);
  return (schema ? schema.parse(res.body) : res.body) as T;
}

function toApiError(res: TransportResponse): ApiError {
  const parsed = apiErrorBodySchema.safeParse(res.body);
  if (parsed.success) {
    return new ApiError(res.status, parsed.data.code, parsed.data.message, parsed.data.details);
  }
  return new ApiError(res.status, 'INTERNAL', 'Something went wrong');
}

/**
 * True when the installed app is older than the server's minimum. Compares numerically
 * (1.10.0 > 1.2.0). Anything malformed returns false: a bad version string must never lock users
 * out of the app.
 */
export function needsForceUpdate(appVersion: string, minSupported: string): boolean {
  const parse = (v: string) => {
    const parts = v.trim().split('.');
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
    return parts.map(Number);
  };
  const a = parse(appVersion);
  const m = parse(minSupported);
  if (!a || !m) return false;
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const x = a[i] ?? 0;
    const y = m[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
