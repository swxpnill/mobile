import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, BackHandler } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { meSchema } from '@tonnage/shared';
import { api } from '../src/api/client';
import { ME_KEY } from '../src/api/hooks/me';
import { useSession } from '../src/auth/session';
import { TourProvider } from '../src/onboarding/TourProvider';
import { WelcomeHost } from '../src/onboarding/WelcomeHost';
import { holdSplash, resetSplashGateForTests } from '../src/onboarding/splashGate';
import { WELCOME_CAP_MS, WELCOME_ENTER_MS, WELCOME_FADE_MS, WELCOME_SHOW_MS, rearmWelcome, roleBadge, welcomeLine } from '../src/onboarding/welcome';
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
  resetSplashGateForTests();
});
afterEach(() => {
  ctx.client.clear();
  jest.useRealTimers();
  jest.restoreAllMocks();
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

/** Lays the welcome out as on a 915-high screen, its logo slot 200 down the centre column. */
async function layOut() {
  const at = (id: string, y: number, height: number) =>
    fireEvent(screen.getByTestId(id, { includeHiddenElements: true }), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 412, height } },
    });
  await at('welcome', 0, 915);
  await at('welcome-centre', 200, 500);
  await at('welcome-logo-slot', 0, 88);
}

const shown = () => screen.queryByTestId('welcome', { includeHiddenElements: true }) !== null;

describe('welcome back', () => {
  it('shows on a reopened app with the name, role badge and a live line', async () => {
    // Time stands still, so the welcome stays up however slow the machine is.
    jest.useFakeTimers();
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    expect(await screen.findByText('Rajesh')).toBeOnTheScreen();
    expect(screen.getByText('Welcome back')).toBeOnTheScreen();
    expect(screen.getByText('Owner · All units')).toBeOnTheScreen();
    expect(await screen.findByText(/MT pending to dispatch$/)).toBeOnTheScreen();
  });

  it('does not show after a fresh sign-in', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    expect(shown()).toBe(false);
  });

  it('shows again after unlocking', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    expect(shown()).toBe(false);
    await act(async () => useSession.getState().lock());
    await act(async () => useSession.getState().unlock());
    expect(shown()).toBe(true);
  });

  it('starts with the logo where the splash left it, releases the splash, then holds 1.5 s after its entrance', async () => {
    jest.useFakeTimers();
    const hide = jest.fn(() => Promise.resolve());
    holdSplash(hide);
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    await screen.findByText('Rajesh');
    await layOut();
    // Screen centre 457.5; the logo slot's centre is 200 + 0 + 44: it starts 213.5 lower, on the splash's spot.
    expect(screen.getByTestId('welcome-logo', { includeHiddenElements: true })).toHaveStyle({ transform: [{ translateY: 213.5 }] });
    await act(async () => void (await jest.advanceTimersByTimeAsync(50)));
    expect(hide).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('welcome', { includeHiddenElements: true }));
    // A re-layout after the entrance started (the live line arriving) must not reset the clock.
    await fireEvent(screen.getByTestId('welcome-centre', { includeHiddenElements: true }), 'layout', {
      nativeEvent: { layout: { x: 0, y: 190, width: 412, height: 520 } },
    });
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_ENTER_MS + WELCOME_SHOW_MS - 100)));
    expect(shown()).toBe(true);
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_FADE_MS + 300)));
    expect(shown()).toBe(false);
  });

  it('waits for the profile before its first frame, so the layout no longer moves under the logo', async () => {
    const hide = jest.fn(() => Promise.resolve());
    holdSplash(hide);
    await reopenAs(MOBILE.owner);
    ctx.mock.controls.setLatency(400);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    await layOut();
    await act(() => new Promise<void>((r) => setTimeout(r, 100)));
    expect(hide).not.toHaveBeenCalled();
    await screen.findByText('Rajesh', {}, { timeout: 3000 });
    await layOut();
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
  });

  it('keeps the name line and the bottom block at full height before their text arrives', async () => {
    await reopenAs(MOBILE.owner);
    ctx.mock.controls.setLatency(400);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    expect(screen.getByTestId('welcome-bottom', { includeHiddenElements: true })).toHaveStyle({ minHeight: 70 });
    expect(screen.getByTestId('welcome-name', { includeHiddenElements: true })).toHaveStyle({ minHeight: 48 });
  });

  it('with Remove animations on, everything shows at once and it holds 1.5 s', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    jest.useFakeTimers();
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    await screen.findByText('Rajesh');
    await layOut();
    expect(screen.getByTestId('welcome-logo', { includeHiddenElements: true })).toHaveStyle({ transform: [{ translateY: 0 }] });
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_SHOW_MS - 100)));
    expect(shown()).toBe(true);
    await act(async () => void (await jest.advanceTimersByTimeAsync(200)));
    expect(shown()).toBe(false);
  });

  it('closes at once when a notification opens the app', async () => {
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    expect(shown()).toBe(true);
    await act(async () => dismissWelcome());
    expect(shown()).toBe(false);
  });

  it('is followed by the intro when the intro was never seen', async () => {
    jest.useFakeTimers();
    await reopenAs(MOBILE.owner, false);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
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
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    await act(async () => void (await jest.advanceTimersByTimeAsync(300)));
    expect(shown()).toBe(true);
    expect(screen.queryByText('Welcome to Tonnage')).toBeNull();
    await act(async () => void (await jest.advanceTimersByTimeAsync(WELCOME_CAP_MS + WELCOME_FADE_MS + 100)));
    expect(shown()).toBe(false);
    expect(screen.getByText('Welcome to Tonnage')).toBeOnTheScreen();
  });

  it('a sign-out during the welcome leaves nothing for the next person', async () => {
    await reopenAs(MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
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
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    expect(shown()).toBe(true);
    expect(handlers.at(-1)?.()).toBe(true);
    spy.mockRestore();
  });

  it('a notification opened under the fingerprint lock skips the welcome on unlock', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
    await act(async () => useSession.getState().lock());
    await act(async () => dismissWelcome());
    await act(async () => useSession.getState().unlock());
    expect(shown()).toBe(false);
  });

  it('passes the accessibility audit', async () => {
    await reopenAs(MOBILE.supervisor);
    await wrap(ctx.client, <><TourProvider>{null}</TourProvider><WelcomeHost /></>);
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
