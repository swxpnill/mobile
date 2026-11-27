import type { MockControls } from '@tonnage/mock-api';
import { SAMPLE_MASTERS, SAMPLE_WORLD, istDateOf, meSchema, orderListSchema, orderSchema, plantSchema } from '@tonnage/shared';
import { z } from 'zod';
import { useSession } from '../auth/session';
import { onboardingStore } from '../onboarding/store';
import { clearAllVehicleRequestQueues } from '../offline/vehicleRequestQueue';
import { clearAllDeviceStores } from '../offline/sqliteDeviceStore';
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
  // Simulated offline would strand the new person on "Can't reach the server" with no way back
  // to this switch (Demo tools live inside the tabs): a switch always starts online.
  c.setOffline(false);
  await useSession.getState().signIn(pair);
  // Revoked inside the mock, not over the transport: no latency, and an armed failure is kept
  // for the screen the tester is about to try.
  if (previous) await c.revokeRefreshToken(previous);
}

/**
 * Back to the sample data, every simulation off, everyone signed out (this phone too). Every
 * person's device store on this phone is emptied too: its cursor, tasks and events belong to the
 * data that is gone.
 */
export async function resetDemoData(): Promise<void> {
  const c = await controls();
  await c.reset();
  await clearAllDeviceStores(SAMPLE_WORLD.users.map((u) => u.id));
  await clearAllVehicleRequestQueues();
  onboardingStore.getState().reset(); // welcome, intro and tips show again for everyone
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

/** The pretend phone other people act from in `simulateActivity` (never this phone). */
export const DEMO_ACTOR_DEVICE = 'demo-actor-phone';

/**
 * Demo: someone else does something that notifies the person signed in here, so a push shows on
 * this phone (you are never told about your own actions). Money roles: another money person
 * records a ₹1,000 cash payment to R.K. Agarwal. Plant roles: the owner assigns a truck at their
 * plant (supervisors also sync). Real business writes, through the normal API rules.
 * Resolves with what happened, in one line.
 */
export async function simulateActivity(): Promise<string> {
  const c = await controls();
  const mock = await getMockApi();
  const me = meSchema.parse(
    (await mock.transport.request({ method: 'GET', path: '/v1/me', headers: auth(useSession.getState().accessToken) })).body,
  );
  const U = SAMPLE_WORLD.ids.users;
  const money = me.role === 'owner' || me.role === 'city_staff';
  const actorId = money ? ([U.priya, U.amit, U.rajesh].find((id) => id !== me.id) ?? U.priya) : U.rajesh;
  const actor = SAMPLE_WORLD.users.find((u) => u.id === actorId)!;
  const pair = await c.signInAs(actorId, DEMO_ACTOR_DEVICE);
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    mock.transport.request({
      method,
      path,
      body,
      headers: { ...auth(pair.accessToken), 'idempotency-key': `demo-${Date.now()}-${++n}` },
    });
  try {
    const first = actor.name.split(' ')[0];
    if (money) {
      const res = await call('POST', `/v1/brokers/${SAMPLE_MASTERS.ids.parties.rkAgarwal}/payments`, {
        paidRupees: 1_000,
        tdsRupees: 0,
        mode: 'cash',
        utr: null,
        paidOn: istDateOf(Date.now()),
      });
      if (res.status !== 201) throw new Error(`payment refused (${res.status})`);
      return `${first} recorded ₹1,000 cash to R.K. Agarwal.`;
    }
    const plantId = me.plantIds[0];
    const plants = z.array(plantSchema).parse((await call('GET', '/v1/plants')).body);
    const plant = plants.find((p) => p.id === plantId);
    if (!plant) return 'You have no plant to send a truck to.';
    const list = orderListSchema.parse((await call('GET', '/v1/orders?status=all&limit=50')).body);
    for (const summary of list.items) {
      const o = orderSchema.parse((await call('GET', `/v1/orders/${summary.id}`)).body);
      const sub = o.subOrders.find((s) => s.companyId === plant.companyId && (s.status === 'open' || s.status === 'partly_dispatched'));
      const line = sub?.lines.find((l) => l.pendingKg > 0);
      if (!sub || !line) continue;
      const vehicleNo = `CG 04 DM ${String(1000 + Math.floor(Math.random() * 9000))}`;
      const res = await call('POST', `/v1/sub-orders/${sub.id}/trucks`, {
        plantId: plant.id,
        vehicleNo,
        transporterId: null,
        driverName: 'Demo Driver',
        driverPhone: '98261 00099',
        lrNo: null,
        plan: [{ orderLineId: line.id, plannedKg: Math.min(line.pendingKg, 10_000) }],
      });
      if (res.status !== 201) throw new Error(`assign refused (${res.status})`);
      return `${first} assigned ${vehicleNo} at ${plant.name}.`;
    }
    return `No open order at ${plant.name} to load.`;
  } finally {
    await c.revokeRefreshToken(pair.refreshToken);
  }
}

const auth = (token: string | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
