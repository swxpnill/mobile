import { createFakeClock, createMockApi } from '@tonnage/mock-api';
import { registerAll } from './index.ts';

// The M1 contract against the in-process mock. The mock serialises requests, so the
// concurrency case is skipped here and runs against the real API in B1.
registerAll(async () => {
  const clock = createFakeClock(Date.UTC(2026, 10, 3, 4, 30));
  const m = await createMockApi({ clock });
  return {
    transport: m.transport,
    reset: m.controls.reset,
    clock,
    fixtures: m.fixtures,
    capabilities: { concurrency: false },
  };
});
