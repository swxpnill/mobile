import * as Crypto from 'expo-crypto';
import {
  type ErrorCode,
  type HttpMethod,
  NetworkError,
  type TransportResponse,
  apiErrorBodySchema,
} from '@tonnage/shared';
import type { ZodType } from 'zod';
import { useSession } from '../auth/session';
import { WAKING_AFTER_MS, useNetStatus } from './netStatus';
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

export const REQUEST_TIMEOUT_MS = 90_000;

export interface ApiInit<T> {
  method?: HttpMethod;
  body?: unknown;
  /** Adds an `Idempotency-Key`, created once and reused if this call retries. */
  idempotent?: boolean;
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
  const { method = 'GET', body, idempotent, schema, auth = true } = init;
  const key = idempotent ? Crypto.randomUUID() : undefined;

  const send = async (): Promise<TransportResponse> => {
    const headers: Record<string, string> = {};
    const token = useSession.getState().accessToken;
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    return timed((await getTransport()).request({ method, path, headers, body }));
  };

  let res = await send();
  if (res.status === 401 && auth && useSession.getState().refreshToken) {
    const refreshed = await useSession.getState().refresh(); // shared by concurrent callers
    if (refreshed) res = await send();
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

/** Tracks the request for the "Waking server…" banner and gives up after 90 s. */
async function timed<T>(work: Promise<T>): Promise<T> {
  useNetStatus.setState((s) => ({ pending: s.pending + 1 }));
  const waking = setTimeout(() => useNetStatus.setState({ waking: true }), WAKING_AFTER_MS);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new NetworkError('The server took too long to answer')),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(waking);
    clearTimeout(timeout);
    useNetStatus.setState((s) => {
      const pending = Math.max(0, s.pending - 1);
      return { pending, waking: pending > 0 ? s.waking : false };
    });
  }
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
