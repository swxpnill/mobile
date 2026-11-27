import { act, fireEvent, screen } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { meSchema } from '@tonnage/shared';
import { api } from '../src/api/client';
import { ME_KEY } from '../src/api/hooks/me';
import { useSession } from '../src/auth/session';
import { TourProvider } from '../src/onboarding/TourProvider';
import { WELCOME_CAP_MS, WELCOME_FADE_MS, WELCOME_SHOW_MS, rearmWelcome, roleBadge, welcomeLine } from '../src/onboarding/welcome';
import { onboardingStore } from '../src/onboarding/store';
import { dismissWelcome, tourStore } from '../src/onboarding/tourStore';
import { auditA11y } from './a11y/audit';
import { type Ctx, MOBILE, ids, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useFocusEffect: () => undefined }));
jest.mock('../src/onboarding/measure', () => ({ measure: () => undefined }));

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup({ seedOrders: true });
  rearmWelcome();
});
afterEach(() => {
  ctx.client.clear();
  jest.useRealTimers();
});

/** Signs in, then makes it look like the app was reopened (session resumed from storage). */
async function reopenAs(mobile: string, introSeen = true) {
  await signInAs(ctx.mock, mobile);
  useSession.setState({ resumed: true });
  if (introSeen) {
    const id = { [MOBILE.owner]: ids.users.rajesh, [MOBILE.supervisor]: ids.users.ravi }[mobile];
    if (id) onboardingStore.getState().update(id, { introSeen: true });
  }
}

const shown = () => screen.queryByTestId('welcome', { includeHiddenElements: true }) !== null;

describe('welcome back', () => {
  it('shows on a reopened app with the name, role badge and a live line', async () => {
    // Time stands still, so the welcome stays up however slow the machine is.
    jest.useFakeTimers();
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(await screen.findByText('Rajesh')).toBeOnTheScreen();
    expect(screen.getByText('Welcome back')).toBeOnTheScreen();
    expect(screen.getByText('Owner · All units')).toBeOnTheScreen();
    expect(await screen.findByText(/MT pending to dispatch$/)).toBeOnTheScreen();
  });

  it('does not show after a fresh sign-in', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(shown()).toBe(false);
  });

  it('shows again after unlocking', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(shown()).toBe(false);
    await act(async () => useSession.getState().lock());
    await act(async () => useSession.getState().unlock());
    expect(shown()).toBe(true);
  });

  it('stays a full 1.5 s from when it is on screen, then fades; a tap does not close it', async () => {
    jest.useFakeTimers();
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    await screen.findByText('Rajesh');
    await fireEvent(screen.getByTestId('welcome', { includeHiddenElements: true }), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 915 } },
    });
    await fireEvent.press(screen.getByTestId('welcome', { includeHiddenElements: true }));
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_SHOW_MS - 50)));
    expect(shown()).toBe(true);
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_FADE_MS + 200)));
    expect(shown()).toBe(false);
  });

  it('closes at once when a notification opens the app', async () => {
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(shown()).toBe(true);
    await act(async () => dismissWelcome());
    expect(shown()).toBe(false);
  });

  it('is followed by the intro when the intro was never seen', async () => {
    jest.useFakeTimers();
    await reopenAs(MOBILE.owner, false);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_CAP_MS + WELCOME_FADE_MS + 100)));
    expect(shown()).toBe(false);
    expect(tourStore.getState().intro).toBe(true);
  });

  it('the intro sheet waits until the welcome has gone (profile already cached)', async () => {
    await reopenAs(MOBILE.owner, false);
    // A reopened app has the profile from its offline copy on the very first render.
    const first = await wrap(ctx.client, <>{null}</>);
    await ctx.client.fetchQuery({ queryKey: ME_KEY, queryFn: () => api('/v1/me', { schema: meSchema }) });
    await first.unmount();
    jest.useFakeTimers();
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    await act(async () => void (await jest.advanceTimersByTimeAsync(300)));
    expect(shown()).toBe(true);
    expect(screen.queryByText('Welcome to Tonnage')).toBeNull();
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_CAP_MS + WELCOME_FADE_MS + 100)));
    expect(shown()).toBe(false);
    expect(screen.getByText('Welcome to Tonnage')).toBeOnTheScreen();
  });

  it('a sign-out during the welcome leaves nothing for the next person', async () => {
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(shown()).toBe(true);
    await act(async () => useSession.getState().signOut());
    expect(tourStore.getState().welcome).toBe(false);
  });

  it('Android Back does nothing while the welcome shows', async () => {
    const handlers: (() => boolean)[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      handlers.push(h as () => boolean);
      return { remove: () => undefined };
    });
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(shown()).toBe(true);
    expect(handlers.at(-1)?.()).toBe(true);
    spy.mockRestore();
  });

  it('a notification opened under the fingerprint lock skips the welcome on unlock', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    await act(async () => useSession.getState().lock());
    await act(async () => dismissWelcome());
    await act(async () => useSession.getState().unlock());
    expect(shown()).toBe(false);
  });

  it('passes the accessibility audit', async () => {
    await reopenAs(MOBILE.supervisor);
    await wrap(ctx.client, <TourProvider>{null}</TourProvider>);
    expect(await screen.findByText('Ravi')).toBeOnTheScreen();
    // One spoken alert over the app, not a screen of its own: no header rule.
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON, { header: false })).toEqual([]);
  });
});

describe('welcomeLine', () => {
  it('office roles: pending in the viewer’s unit', () => {
    expect(welcomeLine('owner', { pendingKg: 191_600 }, 'mt')).toBe('191.600 MT pending to dispatch');
    expect(welcomeLine('city_staff', { pendingKg: 191_600 }, 'kg')).toBe('1,91,600 kg pending to dispatch');
    expect(welcomeLine('owner', { pendingKg: 0 }, 'mt')).toBe('Nothing pending to dispatch');
  });
  it('plant head: trucks in plant', () => {
    expect(welcomeLine('plant_head', { inPlant: 1 }, 'mt')).toBe('1 truck in plant now');
    expect(welcomeLine('plant_head', { inPlant: 3 }, 'mt')).toBe('3 trucks in plant now');
  });
  it('supervisor: trucks waiting', () => {
    expect(welcomeLine('supervisor', { waiting: 1 }, 'mt')).toBe('1 truck waiting for you');
    expect(welcomeLine('supervisor', { waiting: 0 }, 'mt')).toBe('No trucks waiting yet');
  });
  it('no data yet', () => {
    expect(welcomeLine('owner', {}, 'mt')).toBe('Getting today’s work ready…');
  });
});

describe('roleBadge', () => {
  it('names the scope', () => {
    expect(roleBadge('owner', [], undefined, undefined)).toBe('Owner · All units');
    expect(roleBadge('city_staff', [], undefined, undefined)).toBe('City staff · All units');
  });
});
