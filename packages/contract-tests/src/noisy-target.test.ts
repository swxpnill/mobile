// The contract against a target that behaves like a real HTTP server: every response carries
// per-request headers (Fastify adds `date`, request ids and rate-limit counters). Guards that the
// suite never compares headers it does not own, and that every suite releases its target.
import { afterAll, expect } from 'vitest';
import { createFakeClock, createMockApi } from '@tonnage/mock-api';
import { registerAll } from './index.ts';
let n = 0;
let closed = 0;
registerAll(async () => {
  const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  const m = await createMockApi({ clock });
  return {
    transport: {
      request: async (req) => {
        const res = await m.transport.request(req);
        return { ...res, headers: { ...res.headers, 'x-request-id': String(++n) } };
      },
    },
    reset: m.controls.reset,
    clock,
    fixtures: m.fixtures,
    capabilities: { concurrency: false },
    close: async () => {
      closed += 1;
    },
  };
});
afterAll(() => expect(closed).toBe(6));
