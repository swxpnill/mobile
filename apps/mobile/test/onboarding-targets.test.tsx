import { screen, waitFor } from '@testing-library/react-native';
import type { Role } from '@tonnage/shared';
import { tabsForRole } from '../src/nav/tabs';
import { resetDeviceStoresForTests } from '../src/offline/sqliteDeviceStore';
import { useSync } from '../src/offline/useSync';
import { targetsStore } from '../src/onboarding/targets';
import { stepsFor } from '../src/onboarding/tours';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { TasksScreen } from '../src/screens/supervisor/TasksScreen';
import { TabBar } from '../src/ui';
import { type Ctx, MOBILE, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useFocusEffect: () => undefined }));
// Every target is somewhere on screen.
jest.mock('../src/onboarding/measure', () => ({
  measure: (_n: unknown, cb: (x: number, y: number, w: number, h: number) => void) => cb(1, 1, 10, 10),
}));

let ctx: Ctx;

/** The signed-in layout's sync loop, as `app/(app)/_layout.tsx` mounts it. */
function SyncHost() {
  useSync();
  return null;
}
beforeEach(async () => {
  resetDeviceStoresForTests();
  ctx = await setup({ seedOrders: true });
});
afterEach(() => ctx.client.clear());

const registered = () => Object.keys(targetsStore.getState().rects);
const targetsOf = (role: Role) => stepsFor(role, 'X').flatMap((s) => (s.target ? [s.target] : []));

describe('tour targets on the real screens', () => {
  it.each(['owner', 'city_staff', 'plant_head'] as const)('%s: Home and the tab bar carry every target', async (role) => {
    await signInAs(ctx.mock, MOBILE[role]);
    await wrap(
      ctx.client,
      <>
        <HomeScreen />
        <TabBar tabs={tabsForRole(role)} active="home" onPress={() => undefined} />
      </>,
    );
    await screen.findAllByText(/open order/i, {}, { timeout: 3000 });
    await waitFor(() => expect(registered()).toEqual(expect.arrayContaining(targetsOf(role))));
  });

  it('supervisor: My tasks and the tab bar carry every target', async () => {
    await signInAs(ctx.mock, MOBILE.supervisor);
    await wrap(
      ctx.client,
      <>
        <SyncHost />
        <TasksScreen />
        <TabBar tabs={tabsForRole('supervisor')} active="tasks" onPress={() => undefined} />
      </>,
    );
    await screen.findByLabelText(/^CG 04 MK 2291/, {}, { timeout: 3000 });
    await waitFor(() => expect(registered()).toEqual(expect.arrayContaining(targetsOf('supervisor'))));
  });
});
