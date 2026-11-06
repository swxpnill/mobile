import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { z } from 'zod';
import {
  type ApiErrorBody,
  type ErrorCode,
  type HttpMethod,
  SAMPLE_WORLD,
  type TokenPair,
  type Transport,
  type TransportResponse,
  apiErrorBodySchema,
  tokenPairSchema,
} from '@tonnage/shared';

/** Test-only hooks a target must offer so the suite can set up cross-tenant cases. */
export interface ContractFixtures {
  /**
   * A second tenant: one owner (never signed in), one company `TNT`, one plant. `ownerMobile` is
   * normalised (`+91…`), not used by `SAMPLE_WORLD`, and unique across calls until `reset()`.
   */
  createTenant(
    name: string,
  ): Promise<{ tenantId: string; ownerMobile: string; companyId: string; plantId: string }>;
  /**
   * A truck in any state on an existing sub-order, until F3 adds the real assign/weigh flow.
   * Dispatched trucks carry net allocations; others carry only a plan. B2 inserts it with SQL.
   */
  addTruck(input: {
    subOrderId: string;
    state: 'assigned' | 'at_gate' | 'loading' | 'dispatched' | 'cancelled';
    vehicleNo: string;
    tareKg?: number;
    plan: { orderLineId: string; plannedKg: number }[];
    allocations?: { orderLineId: string; netKg: number }[];
  }): Promise<{ truckId: string }>;
}

/**
 * Anything that serves the API contract: the in-process mock today, Fastify + Postgres in B1.
 *
 * Target requirements:
 * - `clock` drives every time rule (token expiry, OTP expiry and lockout, refresh grace,
 *   idempotency retention). Windows are half-open: a 30 s window is over at exactly 30 000 ms.
 * - Rate limiting is off: the suite sends far more auth requests than a real client.
 * - Response header names are lower-case; a 204 has no body (`null` or `undefined`).
 * - `reset()` returns to `SAMPLE_WORLD` with no sessions, challenges, lockouts or idempotency keys.
 */
export interface ContractTarget {
  transport: Transport;
  reset(): Promise<void>;
  clock: { advance(ms: number): void };
  fixtures: ContractFixtures;
  capabilities: {
    /** The target really runs requests concurrently (the mock serialises them). */
    concurrency: boolean;
  };
  /** Releases the target (server, DB pool). Called once after each suite. */
  close?(): Promise<void>;
}

export type TargetFactory = () => Promise<ContractTarget>;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

export const DEVICE_A = '019a4c00-00ff-7000-8000-00000000000a';
export const DEVICE_B = '019a4c00-00ff-7000-8000-00000000000b';
/** A well-formed id that exists nowhere. */
export const RANDOM_ID = '019a4c00-0fff-7000-8000-000000000999';
export const DEV_CODE = '123456';

const { ids } = SAMPLE_WORLD;
export const COMPANY = ids.companies;
export const PLANT = ids.plants;

function person(id: string) {
  const u = SAMPLE_WORLD.users.find((x) => x.id === id);
  if (!u) throw new Error(`SAMPLE_WORLD has no user ${id}`);
  return u;
}
/** The canvas cast, by first name. */
export const PEOPLE = {
  rajesh: person(ids.users.rajesh), // owner
  priya: person(ids.users.priya), // city staff
  amit: person(ids.users.amit), // city staff
  ravi: person(ids.users.ravi), // supervisor · Siltara
  sanjay: person(ids.users.sanjay), // supervisor · Borai
  deepak: person(ids.users.deepak), // supervisor · Tilda, invited (never signed in)
  kiran: person(ids.users.kiran), // plant head · Siltara
};

/**
 * Declares the per-suite target: built once, reset before every test, so tests never depend on
 * each other's data.
 */
export function useTarget(factory: TargetFactory): () => ContractTarget {
  let target: ContractTarget | undefined;
  beforeAll(async () => {
    target = await factory();
  });
  beforeEach(async () => {
    await target?.reset();
  });
  afterAll(async () => {
    await target?.close?.();
    target = undefined;
  });
  return () => {
    if (!target) throw new Error('contract target not ready');
    return target;
  };
}

let keySeq = 0;
/** A fresh `Idempotency-Key`. */
export function newKey(): string {
  keySeq += 1;
  return `contract-${Date.now().toString(36)}-${keySeq}`;
}

export function call(
  t: ContractTarget,
  method: HttpMethod,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<TransportResponse> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return t.transport.request({ method, path, headers, body: opts.body });
}

/**
 * Parses `value` with `schema` and fails if parsing changed it — so an extra key (a leaked field,
 * a renamed one) is caught, not silently stripped.
 */
export function parseExact<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.parse(value);
  expect(parsed, 'response has keys the schema does not declare').toEqual(value);
  return parsed;
}

/** Asserts a success status and an exactly-matching body; returns the typed body. */
export function expectOk<S extends z.ZodType>(
  res: TransportResponse,
  schema: S,
  status = 200,
): z.output<S> {
  expect(res.status, `expected ${status}, body: ${JSON.stringify(res.body)}`).toBe(status);
  return parseExact(schema, res.body);
}

/**
 * Two responses a client cannot tell apart: same status and body. Headers are not compared —
 * `date`, request ids and rate-limit counters legitimately differ between any two responses.
 */
export function expectSameResponse(a: TransportResponse, b: TransportResponse): void {
  expect({ status: a.status, body: a.body }).toEqual({ status: b.status, body: b.body });
}

/** Asserts an error status, the `{ code, message, details? }` shape and the code. */
export function expectError(res: TransportResponse, status: number, code: ErrorCode): ApiErrorBody {
  expect(
    { status: res.status, code: (res.body as { code?: unknown } | null)?.code },
    `body: ${JSON.stringify(res.body)}`,
  ).toEqual({ status, code });
  return parseExact(apiErrorBodySchema, res.body);
}

/**
 * The real OTP flow: request-code, then verify with the dev code. If the number asked for a code
 * under 30 s ago, waits out the resend window on the target clock first.
 */
export async function signIn(
  t: ContractTarget,
  mobile: string,
  deviceId: string = DEVICE_A,
  tenantId?: string,
): Promise<TokenPair> {
  let req = await call(t, 'POST', '/v1/auth/request-code', { body: { mobile } });
  if (req.status === 429 && (req.body as { code?: string }).code === 'OTP_RESEND_TOO_SOON') {
    t.clock.advance(30 * SECOND);
    req = await call(t, 'POST', '/v1/auth/request-code', { body: { mobile } });
  }
  expect(req.status, `request-code for ${mobile}: ${JSON.stringify(req.body)}`).toBe(200);
  const res = await call(t, 'POST', '/v1/auth/verify', {
    body: { mobile, code: DEV_CODE, deviceId, ...(tenantId ? { tenantId } : {}) },
  });
  return expectOk(res, tokenPairSchema);
}

/** Access token for a sample-world person. */
export async function tokenFor(t: ContractTarget, who: { mobile: string }): Promise<string> {
  return (await signIn(t, who.mobile)).accessToken;
}
