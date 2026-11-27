import { screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { HomeScreen } from '../src/screens/home/HomeScreen';
import { auditA11y } from './a11y/audit';
import { type Ctx, MOBILE, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup({ seedOrders: true });
  await signInAs(ctx.mock, MOBILE.owner);
  // Home answers slowly, so its first paint is the placeholder.
  ctx.mock.controls.setLatency(400);
});
afterEach(() => {
  ctx.client.clear();
  jest.restoreAllMocks();
});

describe('Home placeholders', () => {
  it('shows a skeleton of the Home layout while loading, never a spinner, then the figures', async () => {
    await wrap(ctx.client, <HomeScreen />);
    const skeleton = screen.getByTestId('home-skeleton');
    expect(skeleton).toBeOnTheScreen();
    expect(screen.getByLabelText('Loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('home-spinner')).toBeNull();
    // Its shape: the pending card, two tiles, three "In plant now" rows.
    expect(screen.getAllByTestId('skeleton-block', { includeHiddenElements: true }).length).toBeGreaterThanOrEqual(10);
    expect(await screen.findByText('Pending dispatch', {}, { timeout: 3000 })).toBeOnTheScreen();
    expect(screen.queryByTestId('home-skeleton')).toBeNull();
  });

  it('pulses gently, and not at all with Remove animations on', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    await wrap(ctx.client, <HomeScreen />);
    await waitFor(() => expect(loop).toHaveBeenCalled());
    loop.mockClear();
    ctx.client.clear();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await wrap(ctx.client, <HomeScreen />);
    expect(screen.getAllByTestId('home-skeleton').length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(loop).not.toHaveBeenCalled();
  });

  it('reads as one "Loading" item to TalkBack and passes the audit', async () => {
    await wrap(ctx.client, <HomeScreen />);
    expect(screen.getByTestId('home-skeleton')).toHaveProp('accessibilityLabel', 'Loading');
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });
});
