import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen, waitFor } from '@testing-library/react-native';
import * as RN from 'react-native';
import { Text } from 'react-native';
import {
  DEVICE_PREFS_KEY,
  DEFAULT_DEVICE_PREFS,
  getDevicePrefs,
  setDevicePrefs,
} from '../src/prefs/device';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { Button, Text as UiText } from '../src/ui';
import { darkTokens, lightTokens, typeScale, unitTagColors } from '../src/theme/tokens';

function Probe() {
  const { t, mode, scale } = useTheme();
  return <Text testID="probe">{`${t.bg}|${mode}|${scale}`}</Text>;
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('tokens', () => {
  it('match the canvas', () => {
    expect(lightTokens.bg).toBe('#F4F5F7');
    expect(darkTokens.bg).toBe('#09090B');
    expect(lightTokens.inv).toBe('#2563EB');
    expect(darkTokens.brt).toBe('#8AB0FF');
    expect(lightTokens.dgs).toBe('rgba(242,54,69,.09)');
  });

  it('light and dark define exactly the same keys', () => {
    expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(lightTokens).sort());
  });

  it('unit tag slots 0–3 have light and dark text colours', () => {
    expect(unitTagColors(0, 'light')).toEqual({ bg: lightTokens.brs, fg: '#1D4ED8' });
    expect(unitTagColors(2, 'dark')).toEqual({ bg: darkTokens.oks, fg: '#3CC7B4' });
    expect(unitTagColors(5, 'light')).toEqual(unitTagColors(1, 'light')); // slot wraps mod 4
  });

  it('type scale from the canvas', () => {
    expect(typeScale.title).toMatchObject({ fontSize: 28, lineHeight: 34 });
    expect(typeScale.title.letterSpacing).toBeCloseTo(-0.7);
    expect(typeScale.overline).toMatchObject({
      fontSize: 11,
      lineHeight: 14,
      textTransform: 'uppercase',
    });
  });
});

describe('device prefs', () => {
  it('defaults when nothing is stored, and when storage holds garbage', async () => {
    expect(await getDevicePrefs()).toEqual(DEFAULT_DEVICE_PREFS);
    await AsyncStorage.setItem(DEVICE_PREFS_KEY, '{not json');
    expect(await getDevicePrefs()).toEqual(DEFAULT_DEVICE_PREFS);
    await AsyncStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ themeMode: 'purple' }));
    expect(await getDevicePrefs()).toEqual(DEFAULT_DEVICE_PREFS);
  });

  it('setDevicePrefs merges and persists', async () => {
    await setDevicePrefs({ themeMode: 'dark' });
    await setDevicePrefs({ textSize: 'large' });
    expect(await getDevicePrefs()).toEqual({
      ...DEFAULT_DEVICE_PREFS,
      themeMode: 'dark',
      textSize: 'large',
    });
  });
});

describe('ThemeProvider', () => {
  it("mode 'dark' → useTheme().t.bg === '#09090B'; textSize 'large' → scale 1.15", async () => {
    await setDevicePrefs({ themeMode: 'dark', textSize: 'large' });
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('#09090B|dark|1.15'));
  });

  it("mode 'auto' follows the system colour scheme", async () => {
    jest.spyOn(RN, 'useColorScheme').mockReturnValue('dark');
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('#09090B|auto|1'));
    jest.restoreAllMocks();
  });

  it('Large text scales every label, including ones with their own size (button, chip)', async () => {
    await setDevicePrefs({ textSize: 'large' });
    await render(
      <ThemeProvider>
        <Button onPress={() => {}}>Send code</Button>
        <UiText variant="body">Body</UiText>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByText('Body')).toHaveStyle({ fontSize: 14 * 1.15 }));
    expect(screen.getByText('Send code')).toHaveStyle({ fontSize: 15 * 1.15 });
  });

  it('defaults to light on a light system', async () => {
    jest.spyOn(RN, 'useColorScheme').mockReturnValue('light');
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('#F4F5F7|auto|1'));
    jest.restoreAllMocks();
  });
});
