import {
  NetworkError,
  ROLES,
  type ErrorCode,
  type Role,
  type TokenPair,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@tonnage/shared';
import { type AddTruckInput, addTruck } from './trucks.ts';
import { type Clock, toIso } from './clock.ts';
import { errorBody } from './errors.ts';
import { issueTokens } from './sessions.ts';
import type { Store } from './store.ts';

/** A person as the demo "Sign in as" list shows them (mock only; not part of the API). */
export interface DemoUser {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  mobile: string;
  role: Role;
  /** "Aarav Ispat Pvt Ltd · Siltara" for plant roles; empty for all-unit roles. */
  plants: string[];
  active: boolean;
}

export type ArmedFailure =
  | { kind: 'http'; status: number; code: ErrorCode; writesOnly: boolean }
  | { kind: 'network'; writesOnly: boolean };

export interface MockControls {
  /** Restore the seed data, clear sessions, and turn every simulation off (offline, latency, armed failure). */
  reset(): Promise<void>;
  /** While on, every request rejects with `NetworkError`. */
  setOffline(on: boolean): void;
  /** Delay every response by `ms`. */
  setLatency(ms: number): void;
  /**
   * The next request (only that one) returns `status` with `{ code, message }`. With
   * `writesOnly`, reads and auth calls pass and the next save fails (e.g. STALE).
   */
  failNext(status: number, code: ErrorCode, opts?: { writesOnly?: boolean }): void;
  /** The next request (only that one) rejects with `NetworkError` (the connection drops). */
  dropNext(opts?: { writesOnly?: boolean }): void;
  /** Disarm a pending failNext / dropNext. */
  clearFailNext(): void;
  /** A copy of the current simulation settings, for the demo screen. */
  getState(): ControlState;
  /** Everyone, active first, then by business name, role and name. */
  listUsers(): Promise<DemoUser[]>;
  /** Revoke a refresh token directly (demo person switch): no request, so no simulation applies. */
  revokeRefreshToken(refreshToken: string): Promise<void>;
  /** Demo quick-switch: a token pair for the user without the OTP flow. */
  signInAs(userId: string, deviceId: string): Promise<TokenPair>;
  /** Insert a truck in any state (until F3 builds assignment and weighing). */
  addTruck(input: AddTruckInput): Promise<{ truckId: string }>;
  /** Record counts, for demo screens and tests. */
  stats(): Promise<{ orders: number; trucks: number; parties: number; products: number }>;
}

export interface ControlState {
  offline: boolean;
  latencyMs: number;
  failNext: ArmedFailure | null;
}

export type Enqueue = <T>(fn: () => Promise<T>) => Promise<T>;

/** Serial promise queue: the mock processes one request at a time (no fake concurrency). */
export function createQueue(): Enqueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** A request that changes business data: not a read, and not sign-in / refresh / sign-out. */
const isSave = (req: TransportRequest) => req.method !== 'GET' && !req.path.startsWith('/v1/auth/');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTransport(deps: {
  controls: ControlState;
  enqueue: Enqueue;
  handle(req: TransportRequest): Promise<TransportResponse>;
}): Transport {
  const { controls: cs, enqueue, handle } = deps;
  return {
    async request(req) {
      if (cs.offline) throw new NetworkError('Offline (simulated)');
      if (cs.latencyMs > 0) await sleep(cs.latencyMs);
      if (cs.offline) throw new NetworkError('Offline (simulated)');
      return enqueue(async () => {
        const fail = cs.failNext;
        if (fail && (!fail.writesOnly || isSave(req))) {
          cs.failNext = null;
          if (fail.kind === 'network') throw new NetworkError('Connection dropped (simulated)');
          return {
            status: fail.status,
            headers: { 'content-type': 'application/json' },
            body: errorBody(fail.code),
          };
        }
        return handle(req);
      });
    },
  };
}

export function createControls(deps: {
  controls: ControlState;
  enqueue: Enqueue;
  store: Store;
  clock: Clock;
}): MockControls {
  const { controls: cs, enqueue, store, clock } = deps;
  return {
    reset: () =>
      enqueue(async () => {
        cs.offline = false;
        cs.latencyMs = 0;
        cs.failNext = null;
        await store.reset();
      }),
    setOffline(on) {
      cs.offline = on;
    },
    setLatency(ms) {
      cs.latencyMs = Math.max(0, ms);
    },
    failNext(status, code, opts) {
      cs.failNext = { kind: 'http', status, code, writesOnly: opts?.writesOnly ?? false };
    },
    dropNext(opts) {
      cs.failNext = { kind: 'network', writesOnly: opts?.writesOnly ?? false };
    },
    clearFailNext() {
      cs.failNext = null;
    },
    addTruck: (input) =>
      enqueue(async () => {
        const truckId = addTruck(store.state, input, clock.now());
        store.schedulePersist();
        return { truckId };
      }),
    stats: () =>
      enqueue(async () => {
        const s = store.state;
        return {
          orders: s.orders.length,
          trucks: s.trucks.length,
          parties: s.parties.length,
          products: s.products.length,
        };
      }),
    getState: () => ({
      offline: cs.offline,
      latencyMs: cs.latencyMs,
      failNext: cs.failNext ? { ...cs.failNext } : null,
    }),
    revokeRefreshToken: (refreshToken) =>
      enqueue(async () => {
        const rec = store.state.refreshTokens[refreshToken];
        if (rec && rec.revokedAt === null) {
          rec.revokedAt = toIso(clock.now());
          store.schedulePersist();
        }
      }),
    listUsers: () =>
      enqueue(async () => {
        const st = store.state;
        const rank = (r: Role) => ROLES.indexOf(r);
        return st.users
          .map((u): DemoUser => ({
            id: u.id,
            tenantId: u.tenantId,
            tenantName: st.tenants.find((t) => t.id === u.tenantId)?.name ?? '',
            name: u.name,
            mobile: u.mobile,
            role: u.role,
            plants: u.plantIds.flatMap((id) => {
              const p = st.plants.find((x) => x.id === id);
              if (!p) return [];
              const c = st.companies.find((x) => x.id === p.companyId);
              return [c ? `${c.name} · ${p.name}` : p.name];
            }),
            active: u.active,
          }))
          .sort(
            (a, b) =>
              Number(b.active) - Number(a.active) ||
              a.tenantName.localeCompare(b.tenantName) ||
              rank(a.role) - rank(b.role) ||
              a.name.localeCompare(b.name),
          );
      }),
    signInAs: (userId, deviceId) =>
      enqueue(async () => {
        const now = clock.now();
        const user = store.state.users.find((u) => u.id === userId);
        if (!user || !user.active) throw new Error(`signInAs: no active user ${userId}`);
        user.lastSeenAt = toIso(now);
        const pair = issueTokens(store.state, user.id, deviceId, now);
        store.schedulePersist();
        return pair;
      }),
  };
}
