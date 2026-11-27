import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

let mockRect = [10, 20, 100, 40];
jest.mock('../src/onboarding/measure', () => ({
  measure: (_node: unknown, cb: (x: number, y: number, w: number, h: number) => void) =>
    cb(mockRect[0]!, mockRect[1]!, mockRect[2]!, mockRect[3]!),
}));
import { intersects, placeCard, spotlightPath } from '../src/onboarding/geometry';
import { TourTarget } from '../src/onboarding/TourTarget';
import { targetsStore } from '../src/onboarding/targets';

const SCREEN = { w: 412, h: 915 };

beforeEach(() => targetsStore.setState({ rects: {}, tick: 0 }));

describe('spotlightPath', () => {
  it('without a hole is the screen rect only', () => {
    const d = spotlightPath(SCREEN, null);
    expect(d.match(/M/g)).toHaveLength(1);
  });

  it('with a hole has two subpaths and the hole starts at x - pad', () => {
    const d = spotlightPath(SCREEN, { x: 20, y: 100, w: 200, h: 50 }, 6, 16);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toContain('M30 94'); // x - pad + radius, y - pad
  });

  it('clamps the radius to half the hole', () => {
    const d = spotlightPath(SCREEN, { x: 20, y: 100, w: 10, h: 10 }, 0, 40);
    expect(d).toContain('M25 100');
  });
});

describe('placeCard', () => {
  it('goes below the hole when it fits', () => {
    expect(placeCard(SCREEN, { x: 14, y: 20, w: 160, h: 50 }, 220).top).toBe(20 + 50 + 6 + 16);
  });
  it('goes above when below does not fit', () => {
    expect(placeCard(SCREEN, { x: 170, y: 840, w: 70, h: 60 }, 220).top).toBe(840 - 6 - 16 - 220);
  });
  it('is centred when neither fits or there is no hole', () => {
    expect(placeCard(SCREEN, { x: 0, y: 60, w: 412, h: 800 }, 220).top).toBe((915 - 220) / 2);
    expect(placeCard(SCREEN, null, 220).top).toBe((915 - 220) / 2);
  });
});

describe('off-screen targets', () => {
  it('a hole wholly below or above the screen counts as no hole', () => {
    expect(placeCard(SCREEN, { x: 14, y: 1200, w: 380, h: 200 }, 220).top).toBe((915 - 220) / 2);
    expect(placeCard(SCREEN, { x: 14, y: -400, w: 380, h: 200 }, 220).top).toBe((915 - 220) / 2);
  });
  it('the card always stays inside the screen', () => {
    const top = placeCard(SCREEN, { x: 14, y: 890, w: 380, h: 200 }, 220).top;
    expect(top).toBeGreaterThanOrEqual(16);
    expect(top + 220).toBeLessThanOrEqual(915 - 16);
  });
  it('intersects tells whether any of a rect is on screen', () => {
    expect(intersects(SCREEN, { x: 0, y: 900, w: 10, h: 40 })).toBe(true);
    expect(intersects(SCREEN, { x: 0, y: 915, w: 10, h: 40 })).toBe(false);
    expect(intersects(SCREEN, { x: 0, y: -40, w: 10, h: 40 })).toBe(false);
  });
});

describe('TourTarget', () => {
  it('registers its window rect and clears it on unmount', async () => {
    mockRect = [10, 20, 100, 40];
    const r = await render(
      <TourTarget id="home.units">
        <Text>Units</Text>
      </TourTarget>,
    );
    expect(targetsStore.getState().rects['home.units']).toEqual({ x: 10, y: 20, w: 100, h: 40 });
    await r.unmount();
    expect(targetsStore.getState().rects['home.units']).toBeUndefined();
  });

  it('a zero-size target counts as absent', async () => {
    mockRect = [10, 20, 0, 0];
    await render(
      <TourTarget id="home.units">
        <Text>Units</Text>
      </TourTarget>,
    );
    expect(targetsStore.getState().rects['home.units']).toBeUndefined();
  });
});
