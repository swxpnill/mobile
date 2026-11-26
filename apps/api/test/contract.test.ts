import { M1_SUITES, M2_SUITES, registerSuites } from '@tonnage/contract-tests';
import { createFakeClock } from '@tonnage/mock-api';
import { seed } from '../src/db/seed.ts';
import { apiFixtures } from './api-fixtures.ts';
import { fastifyTransport } from './fastify-transport.ts';
import { buildTestApp } from './helpers.ts';

// The M1 and M2 contract against Fastify + Postgres (B1 Ruling 2, B2 Ruling 9). Each suite builds its own app. The clock
// starts where the mock target's does and, as on the mock, `reset` does not rewind it: every case
// reads times relative to `clock.now()`, and truncate + seed drops all clock-dependent state.
registerSuites([...M1_SUITES, ...M2_SUITES], async () => {
  const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  const t = await buildTestApp({ clock, env: { RATE_LIMIT: 'off' } });
  return {
    transport: fastifyTransport(t.app),
    reset: async () => {
      await t.reset();
      await seed(t.ownerDb, clock);
    },
    clock,
    fixtures: apiFixtures(t.ownerDb, clock),
    capabilities: { concurrency: true },
    close: () => t.close(),
  };
});
