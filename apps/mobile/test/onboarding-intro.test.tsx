import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { onboardingStore } from '../src/onboarding/store';
import { TourProvider } from '../src/onboarding/TourProvider';
import { tourStore } from '../src/onboarding/tourStore';
import { auditA11y } from './a11y/audit';
import { type Ctx, MOBILE, ids, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useFocusEffect: () => undefined }));
jest.mock('../src/onboarding/measure', () => ({ measure: () => undefined }));

let ctx: Ctx;
beforeEach(async () => {
  jest.clearAllMocks();
  ctx = await setup();
});
afterEach(() => ctx.client.clear());

describe('tour intro', () => {
  it('shows once on first sign-in, with the role’s three points', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(await screen.findByText('Welcome to Tonnage')).toBeOnTheScreen();
    expect(screen.getByText('Book orders across all your companies')).toBeOnTheScreen();
    expect(screen.getByText('Brokers, dues and reports')).toBeOnTheScreen();
    expect(screen.getByText('Replay anytime from More → Help & tour')).toBeOnTheScreen();
  });

  it('Skip for now sets introSeen and it does not come back', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    const view = await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(onboardingStore.getState().byUser[ids.users.rajesh]?.introSeen).toBe(true);
    await view.unmount();
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(screen.queryByText('Welcome to Tonnage')).toBeNull();
  });

  it('Start tour sets introSeen and starts the tour on the first tab', async () => {
    await signInAs(ctx.mock, MOBILE.supervisor);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(await screen.findByText('Replay anytime from Profile → Help & tour')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Start tour · 1 min' }));
    expect(onboardingStore.getState().byUser[ids.users.ravi]?.introSeen).toBe(true);
    expect(mockRouter.navigate).toHaveBeenCalledWith('/tasks');
    await waitFor(() => expect(tourStore.getState().tour?.steps[0]?.tag).toBe('Today'));
  });

  it('passes the accessibility audit', async () => {
    await signInAs(ctx.mock, MOBILE.plant_head);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(await screen.findByText('No prices')).toBeOnTheScreen();
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });
});
