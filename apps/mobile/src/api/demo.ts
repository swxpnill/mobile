import type { MockControls } from '@tonnage/mock-api';
import { revoke, useSession } from '../auth/session';
import { API_MODE, getMockApi } from './transport';

interface DemoEnv {
  mode: 'mock' | 'http';
  dev: boolean;
  flag: string | undefined;
}

const currentEnv = (): DemoEnv => ({
  mode: API_MODE,
  dev: typeof __DEV__ !== 'undefined' && __DEV__,
  flag: process.env.EXPO_PUBLIC_DEMO_TOOLS,
});

/**
 * Demo tools exist only over the in-app mock (they drive it directly), and in a release build
 * only when the client demo build opts in with EXPO_PUBLIC_DEMO_TOOLS=1. Never against the real API.
 */
export function demoToolsEnabled(env: DemoEnv = currentEnv()): boolean {
  return env.mode === 'mock' && (env.dev || env.flag === '1');
}

/** The mock's demo controls; `null` in http mode or when demo tools are off. */
export async function getMockControls(): Promise<MockControls | null> {
  if (!demoToolsEnabled()) return null;
  return (await getMockApi()).controls;
}

async function controls(): Promise<MockControls> {
  const c = await getMockControls();
  if (!c) throw new Error('Demo tools are not available in this build');
  return c;
}

/**
 * Switch to another person without the OTP flow. The new pair is stored first (so the app never
 * passes through the sign-in screen), then the previous refresh token is revoked as a real
 * sign-out would. The identity change wipes the previous person's cached data (UnitBasisProvider).
 */
export async function signInAsDemo(userId: string): Promise<void> {
  const c = await controls();
  const previous = useSession.getState().refreshToken;
  const pair = await c.signInAs(userId, await useSession.getState().ensureDeviceId());
  await useSession.getState().signIn(pair);
  // The revoke goes through the mock like any request: it must not use up a failure the tester
  // armed for the next screen, nor fail against simulated offline. The old token then simply
  // expires (mock only).
  const sim = c.getState();
  if (previous && !sim.offline && !sim.failNext) void revoke(previous);
}

/** Back to the sample data, every simulation off, everyone signed out (this phone too). */
export async function resetDemoData(): Promise<void> {
  const c = await controls();
  await c.reset();
  await useSession.getState().signOut();
}

/** The armed-failure choices on the demo screen, in the order shown. */
export const FAILURE_CHOICES = [
  { key: 'none', title: 'None', detail: 'Requests behave normally' },
  {
    key: 'stale',
    title: 'Someone else changed this',
    detail: '409 STALE on the next save',
  },
  { key: 'internal', title: 'Server error', detail: '500 on the next request' },
  { key: 'forbidden', title: 'No access', detail: '403 on the next request' },
  { key: 'network', title: 'Connection drops', detail: 'The next request never arrives' },
] as const;
export type FailureKey = (typeof FAILURE_CHOICES)[number]['key'];

export function armFailure(c: MockControls, key: FailureKey): void {
  switch (key) {
    case 'none':
      return c.clearFailNext();
    case 'stale':
      // Reads never return STALE: arm it for the next write so a save shows the conflict.
      return c.failNext(409, 'STALE', { writesOnly: true });
    case 'internal':
      return c.failNext(500, 'INTERNAL');
    case 'forbidden':
      return c.failNext(403, 'FORBIDDEN');
    case 'network':
      return c.dropNext();
  }
}

export function armedKey(c: MockControls): FailureKey {
  const f = c.getState().failNext;
  if (!f) return 'none';
  if (f.kind === 'network') return 'network';
  if (f.code === 'STALE') return 'stale';
  if (f.code === 'FORBIDDEN') return 'forbidden';
  return 'internal';
}
