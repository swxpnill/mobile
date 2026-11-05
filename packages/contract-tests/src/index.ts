import type { TargetFactory } from './harness.ts';
import { register as auth } from './suites/auth.contract.ts';
import { register as me } from './suites/me.contract.ts';
import { register as org } from './suites/org.contract.ts';
import { register as pipeline } from './suites/pipeline.contract.ts';
import { register as settings } from './suites/settings.contract.ts';
import { register as users } from './suites/users.contract.ts';

export type { ContractFixtures, ContractTarget, TargetFactory } from './harness.ts';

/** Declares every M1 contract suite against the target the factory builds. */
export function registerAll(factory: TargetFactory): void {
  auth(factory);
  pipeline(factory);
  org(factory);
  users(factory);
  me(factory);
  settings(factory);
}
