import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { BackHandler, Pressable, Text } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { useSession } from '../src/auth/session';
import { TourProvider } from '../src/onboarding/TourProvider';
import { onboardingStore } from '../src/onboarding/store';
import { tourStore } from '../src/onboarding/tourStore';
import { targetsStore } from '../src/onboarding/targets';
import { useTour } from '../src/onboarding/useTour';
import { auditA11y } from './a11y/audit';
import { type Ctx, MOBILE, ids, setup, signInAs, wrap } from './onboarding-helpers';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
// Targets are placed by each test through the store, not by a native layout.
// The overlay's own frame in the window (null: not measured); targets come through the store.
let mockFrame: [number, number, number, number] | null = null;
jest.mock('../src/onboarding/measure', () => ({
  measure: (_n: unknown, cb: (x: number, y: number, w: number, h: number) => void) => {
    if (mockFrame) cb(...mockFrame);
  },
}));

let backHandlers: (() => boolean)[] = [];
let ctx: Ctx;
const underneath = jest.fn();

function Starter() {
  const tour = useTour();
  return (
    <>
      {tour.ready ? (
        <Pressable accessibilityRole="button" accessibilityLabel="start" onPress={tour.startTour}>
          <Text>start</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="under" onPress={underneath}>
        <Text>under</Text>
      </Pressable>
    </>
  );
}

const place = () =>
  targetsStore.setState({
    rects: {
      'home.units': { x: 14, y: 40, w: 160, h: 44 },
      'home.pending': { x: 14, y: 150, w: 384, h: 260 },
      'home.inPlant': { x: 14, y: 540, w: 384, h: 220 },
      'tab.new': { x: 170, y: 840, w: 72, h: 56 },
      'tab.orders': { x: 88, y: 840, w: 72, h: 56 },
      'tab.dispatch': { x: 253, y: 840, w: 72, h: 56 },
      'tab.more': { x: 336, y: 840, w: 72, h: 56 },
    },
  });

async function startOwnerTour() {
  await signInAs(ctx.mock, MOBILE.owner);
  await wrap(ctx.client, <TourProvider><Starter /></TourProvider>);
  place();
  await fireEvent.press(await screen.findByRole('button', { name: 'start' }));
  await screen.findByText('Switch between your companies', {}, { timeout: 2000 });
}

const title = () => screen.getByTestId('coach-title').props.children as string;
const progress = () => onboardingStore.getState().byUser[ids.users.rajesh];

beforeEach(async () => {
  jest.clearAllMocks();
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
    backHandlers.push(h as () => boolean);
    return { remove: () => (backHandlers = backHandlers.filter((x) => x !== h)) };
  });
  ctx = await setup();
  mockFrame = null;
});
afterEach(() => ctx.client.clear());

describe('tour', () => {
  it('starts on the first tab and sets introSeen', async () => {
    await startOwnerTour();
    expect(mockRouter.navigate).toHaveBeenCalledWith('/home');
    expect(progress()?.introSeen).toBe(true);
    expect(screen.getByLabelText('Step 1 of 8')).toBeOnTheScreen();
  });

  it('Next and Back move through the owner steps', async () => {
    await startOwnerTour();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(title()).toBe('What still has to go out');
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(title()).toBe('Trucks in your plants now');
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(title()).toBe('What still has to go out');
  });

  it('Android Back goes to the previous step, and on step 1 ends the tour', async () => {
    await startOwnerTour();
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    await act(async () => void backHandlers.at(-1)?.());
    expect(title()).toBe('Switch between your companies');
    await act(async () => void backHandlers.at(-1)?.());
    expect(screen.queryByTestId('coach-title')).toBeNull();
    expect(progress()?.tourDone).toBe(true);
  });

  it('Skip tour ends it and sets tourDone', async () => {
    await startOwnerTour();
    await fireEvent.press(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByTestId('coach-title')).toBeNull();
    expect(progress()?.tourDone).toBe(true);
  });

  it('the last button finishes the tour', async () => {
    await startOwnerTour();
    for (let i = 0; i < 7; i++) await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(title()).toBe('You’re all set, Rajesh');
    await fireEvent.press(screen.getByRole('button', { name: 'Start using Tonnage' }));
    expect(screen.queryByTestId('coach-title')).toBeNull();
    expect(progress()?.tourDone).toBe(true);
  });

  it('a step whose target is missing shows the card centred with no hole', async () => {
    await startOwnerTour();
    await act(async () => targetsStore.getState().clear('home.units'));
    const d = screen.getByTestId('spot-path', { includeHiddenElements: true }).props.d as string;
    expect(d.match(/M/g)).toHaveLength(1);
    expect(screen.queryByTestId('spot-ring', { includeHiddenElements: true })).toBeNull();
  });

  it('the screen underneath cannot be touched during the tour', async () => {
    await startOwnerTour();
    await fireEvent.press(screen.getByText('under', { includeHiddenElements: true }));
    expect(underneath).not.toHaveBeenCalled();
  });

  it('hides while a sheet is open and comes back after', async () => {
    await startOwnerTour();
    await act(async () => onboardingStore.getState().sheetOpened());
    expect(screen.queryByTestId('coach-title')).toBeNull();
    await act(async () => onboardingStore.getState().sheetClosed());
    expect(title()).toBe('Switch between your companies');
  });

  it('signing out mid-tour closes it without marking it done', async () => {
    await startOwnerTour();
    await act(async () => useSession.getState().signOut());
    await waitFor(() => expect(screen.queryByTestId('coach-title')).toBeNull());
    expect(progress()?.tourDone).toBe(false);
  });

  it('the hole follows a target that moves', async () => {
    await startOwnerTour();
    await act(async () => targetsStore.getState().set('home.units', { x: 30, y: 300, w: 160, h: 44 }));
    expect(screen.getByTestId('spot-ring', { includeHiddenElements: true })).toHaveStyle({ left: 30 - 6, top: 300 - 6 });
  });

  it('draws the hole in the overlay’s own coordinates (status bar offset on Android)', async () => {
    mockFrame = [0, 40, 412, 875];
    await startOwnerTour();
    await fireEvent(screen.getByTestId('onboarding-root'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 875 } },
    });
    expect(screen.getByTestId('spot-ring', { includeHiddenElements: true })).toHaveStyle({ left: 14 - 6, top: 40 - 40 - 6 });
  });

  it('a sign-out right after Start tour does not start it for the next person', async () => {
    await signInAs(ctx.mock, MOBILE.owner);
    await wrap(ctx.client, <TourProvider><Starter /></TourProvider>);
    await fireEvent.press(await screen.findByRole('button', { name: 'start' }));
    await act(async () => useSession.getState().signOut());
    await act(() => new Promise<void>((r) => setTimeout(r, 500)));
    expect(tourStore.getState().tour).toBeNull();
  });

  it('the coach card passes the accessibility audit', async () => {
    await startOwnerTour();
    expect(auditA11y(screen.toJSON() as ReactTestRendererJSON)).toEqual([]);
  });
});
