import {
  NetworkError,
  type ErrorCode,
  type TokenPair,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@tonnage/shared';
import { type Clock, toIso } from './clock.ts';
import { errorBody } from './errors.ts';
import { issueTokens } from './sessions.ts';
import type { Store } from './store.ts';

export interface MockControls {
  /** Restore the seed data, clear sessions, and turn off offline / pending failNext. */
  reset(): Promise<void>;
  /** While on, every request rejects with `NetworkError`. */
  setOffline(on: boolean): void;
  /** Delay every response by `ms`. */
  setLatency(ms: number): void;
  /** The next request (only that one) returns `status` with `{ code, message }`. */
  failNext(status: number, code: ErrorCode): void;
  /** Demo quick-switch: a token pair for the user without the OTP flow. */
  signInAs(userId: string, deviceId: string): Promise<TokenPair>;
}

export interface ControlState {
  offline: boolean;
  latencyMs: number;
  failNext: { status: number; code: ErrorCode } | null;
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
        if (fail) {
          cs.failNext = null;
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
        cs.failNext = null;
        await store.reset();
      }),
    setOffline(on) {
      cs.offline = on;
    },
    setLatency(ms) {
      cs.latencyMs = Math.max(0, ms);
    },
    failNext(status, code) {
      cs.failNext = { status, code };
    },
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
