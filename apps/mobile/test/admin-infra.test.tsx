import { act, render, renderHook, screen } from '@testing-library/react-native';
import { NetworkError, type TransportRequest } from '@tonnage/shared';
import { ApiError, api } from '../src/api/client';
import { setTransport } from '../src/api/transport';
import { useSubmitKey } from '../src/api/submitKey';
import { resetSessionForTests } from '../src/auth/session';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost, hideToast, showToast } from '../src/ui/Toast';

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
    act(() => hideToast());
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
  });
});
