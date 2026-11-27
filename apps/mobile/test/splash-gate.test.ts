import {
  SPLASH_HOLD_MAX_MS,
  holdSplash,
  releaseSplash,
  resetSplashGateForTests,
  shouldHoldSplash,
} from '../src/onboarding/splashGate';

beforeEach(() => {
  resetSplashGateForTests();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('splash gate', () => {
  it('holds only for a reopened, signed-in app (the welcome will follow)', () => {
    expect(shouldHoldSplash({ status: 'signedIn', resumed: true })).toBe(true);
    expect(shouldHoldSplash({ status: 'signedIn', resumed: false })).toBe(false);
    expect(shouldHoldSplash({ status: 'locked', resumed: true })).toBe(false);
    expect(shouldHoldSplash({ status: 'signedOut', resumed: false })).toBe(false);
  });

  it('hides once, when the welcome releases it', () => {
    const hide = jest.fn(() => Promise.resolve());
    holdSplash(hide);
    expect(hide).not.toHaveBeenCalled();
    releaseSplash();
    releaseSplash();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('hides anyway after the safety cap', () => {
    const hide = jest.fn(() => Promise.resolve());
    holdSplash(hide);
    jest.advanceTimersByTime(SPLASH_HOLD_MAX_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
    releaseSplash();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('a release with nothing held does nothing', () => {
    expect(() => releaseSplash()).not.toThrow();
  });
});
