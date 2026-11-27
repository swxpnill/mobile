import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { TIP_SETTLE_MS, useFirstTip } from '../src/onboarding/useFirstTip';
import { onboardingStore } from '../src/onboarding/store';
import { TourProvider } from '../src/onboarding/TourProvider';
import { TourTarget } from '../src/onboarding/TourTarget';
import { tourStore } from '../src/onboarding/tourStore';
import { targetsStore } from '../src/onboarding/targets';
import { Screen } from '../src/ui';
import { auditA11y } from './a11y/audit';
import { type Ctx, MOBILE, ids, meLoaded, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    useRouter: () => mockRouter,
    // Focused once, on mount; blurred on unmount.
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]),
  };
});
let mockRect: [number, number, number, number] = [20, 840, 180, 52];
jest.mock('../src/onboarding/measure', () => ({
  measure: (_n: unknown, cb: (x: number, y: number, w: number, h: number) => void) => cb(...mockRect),
}));

function OrderDetailLike() {
  useFirstTip('order.requestVehicle');
  return (
    <TourTarget id="order.requestVehicle">
      <Text>Request vehicle</Text>
    </TourTarget>
  );
}

let ctx: Ctx;
const TIP = 'Need a truck? Ask for one here';
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, TIP_SETTLE_MS + 150)));

async function openAs(mobile: string, introSeen = true) {
  await signInAs(ctx.mock, mobile);
  const id = { [MOBILE.owner]: ids.users.rajesh, [MOBILE.plant_head]: ids.users.kiran }[mobile]!;
  if (introSeen) onboardingStore.getState().update(id, { introSeen: true });
  const view = await wrap(ctx.client, <TourProvider><OrderDetailLike /></TourProvider>);
  await meLoaded(ctx.client);
  return { id, view };
}

beforeEach(async () => {
  mockRect = [20, 840, 180, 52];
  ctx = await setup({ seedOrders: true });
});
afterEach(() => ctx.client.clear());

describe('first-visit tips', () => {
  it('shows once after the screen settles; Got it marks it seen and it never comes back', async () => {
    const { id, view } = await openAs(MOBILE.owner);
    await settle();
    expect(screen.getByText(TIP)).toBeOnTheScreen();
    expect(onboardingStore.getState().byUser[id]?.tipsSeen).toContain('order.requestVehicle');
    await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText(TIP)).toBeNull();
    await view.unmount();
    await wrap(ctx.client, <TourProvider><OrderDetailLike /></TourProvider>);
    await settle();
    expect(screen.queryByText(TIP)).toBeNull();
  });

  it('waits while a sheet is open or the tour shows, then appears', async () => {
    await openAs(MOBILE.owner);
    await act(async () => onboardingStore.getState().sheetOpened());
    await settle();
    expect(screen.queryByText(TIP)).toBeNull();
    await act(async () => onboardingStore.getState().sheetClosed());
    await settle();
    expect(screen.getByText(TIP)).toBeOnTheScreen();
  });

  it('does not show while the intro is up', async () => {
    await openAs(MOBILE.owner, false);
    await settle();
    expect(tourStore.getState().intro).toBe(true);
    expect(screen.queryByText(TIP)).toBeNull();
  });

  it('is off when the person turned tips off', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    onboardingStore.getState().update(ids.users.rajesh, { introSeen: true, tipsOn: false });
    await wrap(ctx.client, <TourProvider><OrderDetailLike /></TourProvider>);
    await meLoaded(ctx.client);
    await settle();
    expect(screen.queryByText(TIP)).toBeNull();
  });

  it('is never shown to a role without the action', async () => {
    await openAs(MOBILE.plant_head);
    await settle();
    expect(screen.queryByText(TIP)).toBeNull();
  });

  it('leaving the screen hides the tip', async () => {
    const { view } = await openAs(MOBILE.owner);
    await settle();
    expect(tourStore.getState().tip).toBe('order.requestVehicle');
    await view.rerender(<></>);
    expect(tourStore.getState().tip).toBeNull();
  });

  it('a target below the visible screen is not shown and not used up', async () => {
    mockRect = [20, 2000, 180, 52];
    const { id } = await openAs(MOBILE.owner);
    await settle();
    expect(screen.queryByText(TIP)).toBeNull();
    expect(onboardingStore.getState().byUser[id]?.tipsSeen ?? []).not.toContain('order.requestVehicle');
  });

  it('is placed in the overlay’s own coordinates (status bar offset)', async () => {
    await openAs(MOBILE.owner);
    mockRect = [0, 40, 412, 875];
    await fireEvent(screen.getByTestId('onboarding-root'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 875 } },
    });
    await settle();
    // Target at window y 840 → overlay y 800: the dot sits on its top edge.
    expect(screen.getByTestId('tip-dot', { includeHiddenElements: true })).toHaveStyle({ top: 800 - 5 });
  });

  it('a tall target keeps the bubble inside the screen', async () => {
    mockRect = [20, 110, 372, 1200];
    await openAs(MOBILE.owner);
    await settle();
    const top = StyleSheet.flatten(screen.getByTestId('tip-bubble').props.style).top as number;
    expect(top).toBeGreaterThanOrEqual(16);
  });

  it('a scroll measures the targets again', async () => {
    await openAs(MOBILE.owner);
    const before = targetsStore.getState().tick;
    await wrap(ctx.client, <Screen title="T"><Text>x</Text></Screen>);
    await fireEvent(screen.getByTestId('screen-scroll'), 'scrollEndDrag', { nativeEvent: {} });
    expect(targetsStore.getState().tick).toBeGreaterThan(before);
  });

  it('passes the accessibility audit', async () => {
    await openAs(MOBILE.owner);
    await settle();
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON, { header: false })).toEqual([]);
  });
});
