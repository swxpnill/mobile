// The native splash must look like the first frame of Welcome back (design addendum 2026-11-27).
import { darkTokens, lightTokens } from '../src/theme/tokens';
import { SPLASH_LOGO_DP } from '../src/onboarding/splashGate';

const app = jest.requireActual('../app.json') as { expo: { plugins: unknown[] } };
/** Resolves an app.json asset path the way the bundler would; throws when the file is missing. */
const asset = (p: string): unknown => jest.requireActual(`../${p.replace(/^\.\//, '')}`);

type SplashOptions = {
  image: string;
  imageWidth: number;
  backgroundColor: string;
  dark: { image: string; backgroundColor: string };
};

function splashOptions(): SplashOptions {
  const entry = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen');
  if (!Array.isArray(entry)) throw new Error('expo-splash-screen has no options');
  return entry[1] as SplashOptions;
}

describe('splash config', () => {
  it('uses the welcome background in both themes', () => {
    const s = splashOptions();
    expect(s.backgroundColor).toBe(lightTokens.bg);
    expect(s.dark.backgroundColor).toBe(darkTokens.bg);
  });

  it('draws the logo at the size Welcome back starts from', () => {
    expect(splashOptions().imageWidth).toBe(SPLASH_LOGO_DP);
  });

  it('points at logo images that exist', () => {
    const s = splashOptions();
    expect(asset(s.image)).toBeTruthy();
    expect(asset(s.dark.image)).toBeTruthy();
    expect(() => asset('./assets/no-such-logo.png')).toThrow();
    expect(s.dark.image).not.toBe(s.image);
  });
});
