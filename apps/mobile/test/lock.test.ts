import { LOCK_AFTER_MS, shouldLock } from '../src/auth/lock';

describe('shouldLock', () => {
  it('locks at exactly 15 minutes idle, not a millisecond before', () => {
    expect(LOCK_AFTER_MS).toBe(15 * 60_000);
    expect(shouldLock({ enabled: true, lastActiveAt: 0, now: 15 * 60_000 })).toBe(true);
    expect(shouldLock({ enabled: true, lastActiveAt: 0, now: 15 * 60_000 - 1 })).toBe(false);
  });

  it('never locks when fingerprint unlock is off', () => {
    expect(shouldLock({ enabled: false, lastActiveAt: 0, now: 10 ** 9 })).toBe(false);
  });
});
