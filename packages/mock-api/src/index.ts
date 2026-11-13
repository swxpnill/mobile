import type { Transport } from '@tonnage/shared';
import { type Clock, systemClock } from './clock.ts';
import {
  type ControlState,
  type MockControls,
  createControls,
  createQueue,
  createTransport,
} from './controls.ts';
import { type MockFixtures, createFixtures } from './fixtures.ts';
import { authRoutes } from './handlers/auth.ts';
import { companyRoutes } from './handlers/companies.ts';
import { meRoutes } from './handlers/me.ts';
import { draftRoutes } from './handlers/drafts.ts';
import { homeRoutes } from './handlers/home.ts';
import { orderLifecycleRoutes } from './handlers/order-lifecycle.ts';
import { orderRoutes } from './handlers/orders.ts';
import { partyRoutes } from './handlers/parties.ts';
import { productRoutes } from './handlers/products.ts';
import { metaRoutes } from './handlers/meta.ts';
import { plantRoutes } from './handlers/plants.ts';
import { settingsRoutes } from './handlers/settings.ts';
import { truckRoutes } from './handlers/trucks.ts';
import { userRoutes } from './handlers/users.ts';
import { createPipeline } from './pipeline.ts';
import { buildRouter } from './router.ts';
import {
  DEFAULT_STORAGE_KEY,
  type StorageAdapter,
  createMemoryStorage,
  createStore,
  seedState,
  type MockState,
} from './store.ts';
import { seedDemoOrders } from './seed-orders.ts';
import type { Clock as ClockT } from './clock.ts';

function seedWithDemoOrders(clock: ClockT): MockState {
  const s = seedState(clock);
  seedDemoOrders(s, clock);
  return s;
}

export { type Clock, createFakeClock, systemClock } from './clock.ts';
export type { ArmedFailure, ControlState, DemoUser, MockControls } from './controls.ts';
export type { MockFixtures } from './fixtures.ts';
export type { AddTruckInput } from './trucks.ts';
export { type StorageAdapter, createMemoryStorage } from './store.ts';
export { DEV_OTP_CODE } from './handlers/auth.ts';

export interface MockApi {
  transport: Transport;
  controls: MockControls;
  fixtures: MockFixtures;
}

export interface CreateMockApiOptions {
  /** Where the state snapshot lives (AsyncStorage in the app). Default: in-memory, not persisted. */
  storage?: StorageAdapter;
  clock?: Clock;
  latencyMs?: number;
  storageKey?: string;
  /** Add the canvas demo orders to the seed (the app). Contract and unit tests leave it off. */
  seedOrders?: boolean;
}

export const ALL_ROUTES = [
  ...authRoutes,
  ...meRoutes,
  ...metaRoutes,
  ...companyRoutes,
  ...plantRoutes,
  ...userRoutes,
  ...settingsRoutes,
  ...partyRoutes,
  ...productRoutes,
  // Drafts before /v1/orders/:id so "drafts" is never read as an order id.
  ...draftRoutes,
  ...orderRoutes,
  ...orderLifecycleRoutes,
  ...truckRoutes,
  ...homeRoutes,
];

/** In-process implementation of the M1 API contract, behind a `Transport`. */
export async function createMockApi(opts: CreateMockApiOptions = {}): Promise<MockApi> {
  const clock = opts.clock ?? systemClock;
  const router = buildRouter(ALL_ROUTES);
  const store = await createStore({
    storage: opts.storage ?? createMemoryStorage(),
    storageKey: opts.storageKey ?? DEFAULT_STORAGE_KEY,
    clock,
    seed: opts.seedOrders ? seedWithDemoOrders : seedState,
  });
  const cs: ControlState = {
    offline: false,
    latencyMs: Math.max(0, opts.latencyMs ?? 0),
    failNext: null,
  };
  const enqueue = createQueue();
  const pipeline = createPipeline({ router, store, clock });
  return {
    transport: createTransport({ controls: cs, enqueue, handle: pipeline.handle }),
    controls: createControls({ controls: cs, enqueue, store, clock }),
    fixtures: createFixtures({ store, clock, enqueue }),
  };
}
