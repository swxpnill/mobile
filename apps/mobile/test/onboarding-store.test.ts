import AsyncStorage from '@react-native-async-storage/async-storage';
import { createElement } from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  DEFAULT_PROGRESS,
  ONBOARDING_KEY,
  onboardingStore,
  resetOnboardingForTests,
} from '../src/onboarding/store';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { Sheet } from '../src/ui/Sheet';

const stored = async () => JSON.parse((await AsyncStorage.getItem(ONBOARDING_KEY)) ?? '{}');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await AsyncStorage.clear();
  resetOnboardingForTests();
});

describe('onboarding store', () => {
  it('hydrate keeps valid fields per person and drops malformed ones', async () => {
    await AsyncStorage.setItem(
      ONBOARDING_KEY,
      JSON.stringify({ u1: { introSeen: true, tipsSeen: ['a', 3], tipsOn: 'yes' }, u2: 'x' }),
    );
    await onboardingStore.getState().hydrate();
    const s = onboardingStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.byUser.u1).toEqual({ ...DEFAULT_PROGRESS, introSeen: true, tipsSeen: ['a'] });
    expect(s.byUser.u2).toBeUndefined();
  });

  it('unreadable JSON hydrates to empty and marks hydrated', async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, '{not json');
    await onboardingStore.getState().hydrate();
    expect(onboardingStore.getState().byUser).toEqual({});
    expect(onboardingStore.getState().hydrated).toBe(true);
  });

  it('update persists per person', async () => {
    onboardingStore.getState().update('u1', { tourDone: true });
    await flush();
    const s = await stored();
    expect(s.u1.tourDone).toBe(true);
    expect(s.u1.introSeen).toBe(false);
    expect(s.u2).toBeUndefined();
  });

  it('an update made before hydration wins over the stored value', async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, JSON.stringify({ u1: { introSeen: false, tourDone: false } }));
    onboardingStore.getState().update('u1', { introSeen: true });
    await onboardingStore.getState().hydrate();
    expect(onboardingStore.getState().byUser.u1?.introSeen).toBe(true);
  });

  it('markTipSeen is idempotent', () => {
    onboardingStore.getState().markTipSeen('u1', 'order.requestVehicle');
    onboardingStore.getState().markTipSeen('u1', 'order.requestVehicle');
    expect(onboardingStore.getState().byUser.u1?.tipsSeen).toEqual(['order.requestVehicle']);
  });

  it('reset() clears everyone; reset(id) only that person', async () => {
    const st = onboardingStore.getState();
    st.update('u1', { introSeen: true });
    st.update('u2', { introSeen: true });
    onboardingStore.getState().reset('u1');
    expect(onboardingStore.getState().byUser.u1).toBeUndefined();
    expect(onboardingStore.getState().byUser.u2?.introSeen).toBe(true);
    onboardingStore.getState().reset();
    await flush();
    expect(onboardingStore.getState().byUser).toEqual({});
    expect(await stored()).toEqual({});
  });

  it('counts open sheets while visible and on unmount', async () => {
    const ui = (visible: boolean) =>
      createElement(
        SafeAreaProvider,
        {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          },
        },
        createElement(
          ThemeProvider,
          null,
          createElement(Sheet, { visible, title: 'T', onClose: () => undefined, children: createElement(Text, null, 'x') }),
        ),
      );
    const r = await render(ui(true));
    expect(onboardingStore.getState().openSheets).toBe(1);
    await r.rerender(ui(false));
    expect(onboardingStore.getState().openSheets).toBe(0);
    await r.rerender(ui(true));
    expect(onboardingStore.getState().openSheets).toBe(1);
    await r.unmount();
    expect(onboardingStore.getState().openSheets).toBe(0);
  });
});
