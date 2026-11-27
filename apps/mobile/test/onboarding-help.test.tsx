import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { MoreScreen } from '../src/screens/MoreScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { HelpTourScreen } from '../src/screens/help/HelpTourScreen';
import { onboardingStore } from '../src/onboarding/store';
import { TourProvider } from '../src/onboarding/TourProvider';
import { tourStore } from '../src/onboarding/tourStore';
import { ToastHost } from '../src/ui';
import { auditA11y } from './a11y/audit';
import { type Ctx, MOBILE, ids, meLoaded, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../src/onboarding/measure', () => ({ measure: () => undefined }));

let ctx: Ctx;
beforeEach(async () => {
  jest.clearAllMocks();
  ctx = await setup();
});
afterEach(() => ctx.client.clear());

async function helpAs(mobile: string) {
  await signInAs(ctx.mock, mobile);
  for (const id of Object.values(ids.users)) onboardingStore.getState().update(id, { introSeen: true });
  await wrap(
    ctx.client,
    <TourProvider>
      <HelpTourScreen />
      <ToastHost />
    </TourProvider>,
  );
  await meLoaded(ctx.client);
}

describe('Help & tour entry', () => {
  it.each([MOBILE.owner, MOBILE.city_staff, MOBILE.plant_head])('More has Help & tour (%s)', async (mobile) => {
    await signInAs(ctx.mock, mobile);
    await wrap(ctx.client, <MoreScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Help & tour' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/help');
  });

  it('the supervisor finds it on Profile', async () => {
    await signInAs(ctx.mock, MOBILE.supervisor);
    await wrap(ctx.client, <ProfileScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Help & tour' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/help');
  });
});

describe('Help & tour screen', () => {
  it('replays the person’s own tour', async () => {
    await helpAs(MOBILE.owner);
    await fireEvent.press(await screen.findByRole('button', { name: /^Replay your tour/ }));
    expect(screen.getByText('Owner · 7 steps · about 1 min')).toBeOnTheScreen();
    expect(mockRouter.navigate).toHaveBeenCalledWith('/home');
    await waitFor(() => expect(tourStore.getState().tour?.preview).toBe(false));
  });

  it('owner previews the other roles’ tours; the plant head sees none', async () => {
    await helpAs(MOBILE.owner);
    expect(await screen.findByText('What your team sees')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Owner tour/ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /^Supervisor tour/ }));
    const t = tourStore.getState().tour;
    expect(t?.preview).toBe(true);
    expect(t?.steps.every((s) => s.target === undefined)).toBe(true);
    expect(t?.lastLabel).toBe('Close');
  });

  it('city staff also previews; the plant head does not', async () => {
    await helpAs(MOBILE.city_staff);
    expect(await screen.findByText('What your team sees')).toBeOnTheScreen();
    ctx.client.clear();
    ctx = await setup();
    await helpAs(MOBILE.plant_head);
    expect(await screen.findByText('How do I…')).toBeOnTheScreen();
    expect(screen.queryByText('What your team sees')).toBeNull();
  });

  it('How do I… opens the steps, and Show me goes there', async () => {
    await helpAs(MOBILE.owner);
    await fireEvent.press(await screen.findByRole('button', { name: 'Approve a weighed truck' }));
    expect(await screen.findByText('Open Dispatch and tap To approve.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Show me' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/dispatch');
  });

  it('the tips switch persists, and Show all tips again clears the seen list', async () => {
    await helpAs(MOBILE.owner);
    onboardingStore.getState().markTipSeen(ids.users.rajesh, 'order.requestVehicle');
    await fireEvent.press(await screen.findByRole('switch', { name: 'Show tips on new screens' }));
    expect(onboardingStore.getState().byUser[ids.users.rajesh]?.tipsOn).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Show all tips again' }));
    expect(onboardingStore.getState().byUser[ids.users.rajesh]?.tipsSeen).toEqual([]);
    expect(onboardingStore.getState().byUser[ids.users.rajesh]?.tipsOn).toBe(true);
    expect(await screen.findByText('Tips will show again')).toBeOnTheScreen();
  });

  it('passes the accessibility audit', async () => {
    await helpAs(MOBILE.supervisor);
    expect(await screen.findByText('How do I…')).toBeOnTheScreen();
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });
});
