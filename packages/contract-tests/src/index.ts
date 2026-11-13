import type { TargetFactory } from './harness.ts';
import { register as auth } from './suites/auth.contract.ts';
import { register as masters } from './suites/masters.contract.ts';
import { register as me } from './suites/me.contract.ts';
import { register as lifecycle } from './suites/order-lifecycle.contract.ts';
import { register as orders } from './suites/orders.contract.ts';
import { register as org } from './suites/org.contract.ts';
import { register as pipeline } from './suites/pipeline.contract.ts';
import { register as trucks } from './suites/trucks.contract.ts';
import { register as settings } from './suites/settings.contract.ts';
import { register as users } from './suites/users.contract.ts';

export type { ContractFixtures, ContractTarget, TargetFactory } from './harness.ts';

/** Every contract suite, in run order. Each one builds (and closes) its own target. */
export const CONTRACT_SUITES: readonly ((factory: TargetFactory) => void)[] = [
  auth,
  pipeline,
  org,
  users,
  me,
  settings,
  masters,
  orders,
  lifecycle,
  trucks,
];

/** Declares every contract suite against the target the factory builds. */
export function registerAll(factory: TargetFactory): void {
  for (const register of CONTRACT_SUITES) register(factory);
}
