import type { SessionStatus } from '../auth/session';

/**
 * The native splash draws the "T" glyph this wide (dp), centred (app.json `imageWidth`). Welcome
 * back's first frame draws the same glyph at the same size and place, then animates it into its
 * tile, so the hand-off from native splash to app is invisible (design addendum 2026-11-27).
 */
export const SPLASH_LOGO_DP = 88;

/** The splash is never held longer than this, whatever happens to the welcome. */
export const SPLASH_HOLD_MAX_MS = 2500;

/** A reopened, signed-in app greets with Welcome back: keep the splash up until it is drawn. */
export function shouldHoldSplash(s: { status: SessionStatus; resumed: boolean }): boolean {
  return s.status === 'signedIn' && s.resumed;
}

let pending: (() => Promise<void>) | null = null;
let cap: ReturnType<typeof setTimeout> | undefined;

/** Holds the splash: `hide` runs on `releaseSplash()` or after the safety cap, once. */
export function holdSplash(hide: () => Promise<void>): void {
  pending = hide;
  clearTimeout(cap);
  cap = setTimeout(releaseSplash, SPLASH_HOLD_MAX_MS);
}

/** Welcome back has drawn its first frame (or no welcome is coming): hide the native splash. */
export function releaseSplash(): void {
  clearTimeout(cap);
  const hide = pending;
  pending = null;
  if (hide) void hide().catch(() => undefined);
}

export function resetSplashGateForTests(): void {
  clearTimeout(cap);
  pending = null;
}
