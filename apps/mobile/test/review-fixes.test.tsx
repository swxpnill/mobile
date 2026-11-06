// Regression tests for the Task 6 review findings (Important 1–5, dark danger contrast).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { DEFAULT_DEVICE_PREFS, getDevicePrefs, setDevicePrefs } from '../src/prefs/device';
import { ThemeProvider, useTheme, type ThemeValue } from '../src/theme/ThemeProvider';
import { darkTokens, lightTokens } from '../src/theme/tokens';
import { Badge, Button, OtpInput, Screen, SegmentedControl, UnitTag } from '../src/ui';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('I1: no wrong-theme frame on cold start', () => {
  it('children first render with the stored theme, never the default', async () => {
    await setDevicePrefs({ themeMode: 'dark', textSize: 'large' });
    const seen: string[] = [];
    function Probe() {
      const { t, scale } = useTheme();
      seen.push(`${t.bg}|${scale}`);
      return <Text testID="probe">{t.bg}</Text>;
    }
    await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('#09090B'));
    expect(seen.every((s) => s === '#09090B|1.15')).toBe(true);
  });

  it('reports ready through onReady once prefs are loaded', async () => {
    const onReady = jest.fn();
    await render(
      <ThemeProvider onReady={onReady}>
        <Text>hi</Text>
      </ThemeProvider>,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });
});

describe('I2: overlapping preference changes are never lost', () => {
  it('two overlapping setDevicePrefs calls both persist', async () => {
    await Promise.all([
      setDevicePrefs({ themeMode: 'dark' }),
      setDevicePrefs({ textSize: 'large' }),
    ]);
    expect(await getDevicePrefs()).toEqual({
      ...DEFAULT_DEVICE_PREFS,
      themeMode: 'dark',
      textSize: 'large',
    });
  });

  it('quick Dark then Large through the provider: both on screen and stored', async () => {
    let api: ThemeValue | undefined;
    function Grab() {
      api = useTheme();
      return null;
    }
    await render(
      <ThemeProvider>
        <Grab />
      </ThemeProvider>,
    );
    await waitFor(() => expect(api).toBeDefined());
    await act(async () => {
      void api!.setPrefs({ themeMode: 'dark' });
      void api!.setPrefs({ textSize: 'large' });
    });
    await waitFor(async () =>
      expect(await getDevicePrefs()).toMatchObject({ themeMode: 'dark', textSize: 'large' }),
    );
    expect(api!.prefs).toMatchObject({ themeMode: 'dark', textSize: 'large' });
    expect(api!.t.bg).toBe(darkTokens.bg);
  });

  it('an undefined field in a patch leaves the stored value alone', async () => {
    await setDevicePrefs({ themeMode: 'dark' });
    await setDevicePrefs({ themeMode: undefined, textSize: 'large' });
    expect(await getDevicePrefs()).toMatchObject({ themeMode: 'dark', textSize: 'large' });
  });

  it('a failed write does not throw an unhandled rejection; the choice still shows', async () => {
    let api: ThemeValue | undefined;
    function Grab() {
      api = useTheme();
      return null;
    }
    await render(
      <ThemeProvider>
        <Grab />
      </ThemeProvider>,
    );
    await waitFor(() => expect(api).toBeDefined());
    // The async-storage mock is already a jest.fn: a one-shot implementation, never mockRestore (that
    // would wipe the mock and make every later write a silent no-op).
    jest
      .mocked(AsyncStorage.setItem)
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    await act(async () => {
      await expect(api!.setPrefs({ themeMode: 'dark' })).resolves.toBeUndefined();
    });
    expect(api!.t.bg).toBe(darkTokens.bg);
  });
});

describe('I3: small fixed-height elements do not clip at large system font sizes', () => {
  it('Badge, UnitTag and compact segment cap font scaling and use minHeight', async () => {
    await render(
      <ThemeProvider>
        <Badge kind="ok">Completed</Badge>
        <UnitTag code="AIP" slot={0} />
        <SegmentedControl
          options={[{ value: 'a', label: 'Alpha' }]}
          value="a"
          onChange={() => {}}
        />
      </ThemeProvider>,
    );
    for (const label of ['Completed', 'AIP', 'Alpha']) {
      const text = await screen.findByText(label);
      expect(text.props.maxFontSizeMultiplier).toBeLessThanOrEqual(1.3);
    }
    const flat = (el: { props: Record<string, unknown> }) =>
      Object.assign({}, ...[el.props.style].flat(3).filter(Boolean)) as Record<string, unknown>;
    // Walk up from the label to the pill: the first ancestor that paints a background.
    let badge = screen.getByText('Completed').parent;
    while (badge && flat(badge).backgroundColor === undefined) badge = badge.parent;
    if (!badge) throw new Error('badge container not found');
    expect(flat(badge).height).toBeUndefined();
    expect(flat(badge).minHeight).toBe(22);
  });

  it('OTP digits cap at 1.5×', async () => {
    await render(
      <ThemeProvider>
        <OtpInput value="4" onChange={() => {}} />
      </ThemeProvider>,
    );
    const digit = await screen.findByText('4', { includeHiddenElements: true });
    expect(digit.props.maxFontSizeMultiplier).toBe(1.5);
  });
});

describe('I4: Screen keeps the bottom action above the keyboard', () => {
  it('keyboard prop wraps the screen in a KeyboardAvoidingView; content can grow to push a footer down', async () => {
    await render(
      <ThemeProvider>
        <Screen keyboard>
          <Text>Body</Text>
        </Screen>
      </ThemeProvider>,
    );
    expect(await screen.findByTestId('screen-keyboard')).toBeOnTheScreen();
    expect(screen.getByTestId('screen-scroll').props.contentContainerStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ flexGrow: 1 })]),
    );
  });
});

describe('I5: OTP cursor always sits at the end', () => {
  it('selection is pinned to value.length so a tap cannot insert mid-code', async () => {
    await render(
      <ThemeProvider>
        <OtpInput value="472" onChange={() => {}} />
      </ThemeProvider>,
    );
    expect((await screen.findByLabelText('One-time code')).props.selection).toEqual({
      start: 3,
      end: 3,
    });
  });
});

describe('danger button is legible in dark mode', () => {
  it('fill gives white text at least 4.5:1 contrast in both themes', async () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    for (const t of [lightTokens, darkTokens]) {
      expect((1 + 0.05) / (lum(t.dgf) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    await setDevicePrefs({ themeMode: 'dark' });
    await render(
      <ThemeProvider>
        <Button variant="danger" onPress={() => {}}>
          Delete forever
        </Button>
      </ThemeProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Delete forever' })).toHaveStyle({
      backgroundColor: darkTokens.dgf,
    });
  });
});
