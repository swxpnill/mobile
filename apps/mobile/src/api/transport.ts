import AsyncStorage from '@react-native-async-storage/async-storage';
import { createMockApi, type MockApi } from '@tonnage/mock-api';
import { NetworkError, type Transport, type TransportResponse } from '@tonnage/shared';

/** `mock` (default): the in-app mock API. `http`: the real backend at EXPO_PUBLIC_API_URL. */
export const API_MODE: 'mock' | 'http' =
  process.env.EXPO_PUBLIC_API_MODE === 'http' ? 'http' : 'mock';

let override: Transport | null = null;
let mockApi: Promise<MockApi> | null = null;
let http: Transport | null = null;

/** The single in-app mock, persisted to AsyncStorage so demo data survives restarts. */
export function getMockApi(): Promise<MockApi> {
  mockApi ??= createMockApi({ storage: AsyncStorage, seedOrders: true });
  return mockApi;
}

export async function getTransport(): Promise<Transport> {
  if (override) return override;
  if (API_MODE === 'mock') return (await getMockApi()).transport;
  http ??= createHttpTransport(process.env.EXPO_PUBLIC_API_URL ?? '');
  return http;
}

/** Replaces the in-app mock (tests): its transport and its demo controls are then the same instance. */
export function setMockApi(api: MockApi | null): void {
  mockApi = api ? Promise.resolve(api) : null;
}

/** Replaces the transport (tests). `null` restores the default. */
export function setTransport(t: Transport | null): void {
  override = t;
}

/** `fetch` behind the `Transport` interface: JSON in and out, lower-case headers. */
export function createHttpTransport(baseUrl: string, fetchFn: typeof fetch = fetch): Transport {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async request(req): Promise<TransportResponse> {
      let res: Response;
      try {
        res = await fetchFn(`${root}${req.path}`, {
          method: req.method,
          headers: {
            accept: 'application/json',
            ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...req.headers,
          },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
      } catch (e) {
        throw new NetworkError(e instanceof Error ? e.message : undefined);
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const text = await res.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { code: 'INTERNAL', message: 'Something went wrong' };
        }
      }
      return { status: res.status, headers, body };
    },
  };
}
