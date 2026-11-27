import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

let mockRect = [10, 20, 100, 40];
jest.mock('../src/onboarding/measure', () => ({
  measure: (_node: unknown, cb: (x: number, y: number, w: number, h: number) => void) =>
    cb(mockRect[0]!, mockRect[1]!, mockRect[2]!, mockRect[3]!),
}));
import { placeCard, spotlightPath } from '../src/onboarding/geometry';
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
