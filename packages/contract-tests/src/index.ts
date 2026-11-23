import type { TargetFactory } from './harness.ts';
import { register as auth } from './suites/auth.contract.ts';
import { register as masters } from './suites/masters.contract.ts';
import { register as me } from './suites/me.contract.ts';
import { register as ledger } from './suites/ledger.contract.ts';
import { register as reports } from './suites/reports.contract.ts';
import { register as lifecycle } from './suites/order-lifecycle.contract.ts';
import { register as orders } from './suites/orders.contract.ts';
import { register as org } from './suites/org.contract.ts';
import { register as pipeline } from './suites/pipeline.contract.ts';
import { register as trucks } from './suites/trucks.contract.ts';
import { register as sync } from './suites/sync.contract.ts';
import { register as approval } from './suites/approval.contract.ts';
import { register as supervisors } from './suites/supervisors.contract.ts';
import { register as rejections } from './suites/rejections.contract.ts';
import { register as settings } from './suites/settings.contract.ts';
import { register as users } from './suites/users.contract.ts';
import { register as notifications } from './suites/notifications.contract.ts';

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
  sync,
  approval,
  supervisors,
  rejections,
  ledger,
  reports,
  notifications,
];

/** The M1 suites (B1): sign-in, the request pipeline, companies and plants, users, /me, settings. */
export const M1_SUITES: readonly ((factory: TargetFactory) => void)[] = [
  auth,
  pipeline,
  org,
  users,
  me,
  settings,
];

/** Declares the given suites against the target the factory builds. */
export function registerSuites(
  suites: readonly ((factory: TargetFactory) => void)[],
  factory: TargetFactory,
): void {
  for (const register of suites) register(factory);
}

/** Declares every contract suite against the target the factory builds. */
export function registerAll(factory: TargetFactory): void {
  registerSuites(CONTRACT_SUITES, factory);
}
