import { act, render, renderHook, screen } from '@testing-library/react-native';
import { NetworkError, type TransportRequest } from '@tonnage/shared';
import { ApiError, api } from '../src/api/client';
import { setTransport } from '../src/api/transport';
import { answered, createSingleFlight, useSubmitKey } from '../src/api/submitKey';
import { resetSessionForTests } from '../src/auth/session';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost, showToast } from '../src/ui/Toast';
import { choiceColors } from '../src/ui/Choice';
import { darkTokens, lightTokens } from '../src/theme/tokens';
import { messageFor } from '../src/screens/messages';

beforeEach(() => resetSessionForTests());

describe('api idempotency key', () => {
  it('sends the caller-held key instead of minting a new one', async () => {
    const sent: TransportRequest[] = [];
    setTransport({
      request: async (req) => {
        sent.push(req);
        return { status: 201, headers: {}, body: {} };
      },
    });
    await api('/v1/users', { method: 'POST', body: {}, idempotencyKey: 'form-key-1' });
    await api('/v1/users', { method: 'POST', body: {}, idempotencyKey: 'form-key-1' });
    expect(sent.map((r) => r.headers['idempotency-key'])).toEqual(['form-key-1', 'form-key-1']);
  });
});

describe('useSubmitKey', () => {
  it('keeps the key after a network failure (the first try may have landed) and renews it after an answer', async () => {
    const { result } = await renderHook(() => useSubmitKey());
    const first = result.current.key();
    result.current.settle(new NetworkError('offline'));
    expect(result.current.key()).toBe(first);
    result.current.settle(new ApiError(500, 'INTERNAL', 'x'));
    expect(result.current.key()).toBe(first);
    result.current.settle(new ApiError(409, 'MOBILE_EXISTS', 'x'));
    const second = result.current.key();
    expect(second).not.toBe(first);
    result.current.settle(); // success
    expect(result.current.key()).not.toBe(second);
  });
});

describe('Toast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a message as a live region and hides it after 4 s', async () => {
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <ThemeProvider>
          <ToastHost />
        </ThemeProvider>
      </SafeAreaProvider>,
    );
    act(() => showToast('Someone else changed this. Showing the latest.'));
    const toast = await screen.findByText('Someone else changed this. Showing the latest.');
    expect(toast).toBeOnTheScreen();
    expect(screen.getByTestId('toast').props.accessibilityLiveRegion).toBe('polite');
    act(() => jest.advanceTimersByTime(4_100));
    expect(screen.queryByTestId('toast')).toBeNull();
    screen.unmount(); // before the timers go back to real ones
  });
});

describe('Task 9 review: I1 and I6', () => {
  it('I1: "still processing" keeps the key, so the next tap cannot create a second record', async () => {
    expect(answered(new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'x'))).toBe(false);
    expect(answered(new ApiError(409, 'MOBILE_EXISTS', 'x'))).toBe(true);
    expect(messageFor(new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'x'))).toBe(
      'Still sending your first try. Wait a moment, then try again.',
    );
  });

  it('I6: radio/checkbox outlines and the tick reach 3:1 in both themes', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const t of [lightTokens, darkTokens]) {
      const c = choiceColors(t);
      expect(ratio(c.outline, t.card)).toBeGreaterThanOrEqual(3);
      expect(ratio(c.on, t.card)).toBeGreaterThanOrEqual(3);
      expect(ratio(c.tick, c.on)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('M5: one submit at a time', () => {
  it('a second tap in the same frame is dropped while the first submit runs', async () => {
    const run = createSingleFlight();
    let calls = 0;
    let finish: () => void = () => undefined;
    const work = () =>
      new Promise<void>((r) => {
        calls += 1;
        finish = r;
      });
    const a = run(work);
    const b = run(work); // same frame: before the button re-renders as busy
    finish();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    const c = run(work); // after it settles, the next tap goes through
    finish();
    await c;
    expect(calls).toBe(2);
  });
});
