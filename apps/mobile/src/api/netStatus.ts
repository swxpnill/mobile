import { NetworkError } from '@tonnage/shared';
import { create } from 'zustand';

/** Requests in flight, and whether one has been pending long enough to say "Waking server…". */
export const useNetStatus = create<{ pending: number; waking: boolean }>(() => ({
  pending: 0,
  waking: false,
}));

/** After this long without a response, show the "Waking server…" banner (free-tier cold start). */
export const WAKING_AFTER_MS = 5_000;

/** No answer after this long counts as a network failure. */
export const REQUEST_TIMEOUT_MS = 90_000;

/** Tracks the request for the "Waking server…" banner and gives up after 90 s. */
export async function timed<T>(work: Promise<T>): Promise<T> {
  useNetStatus.setState((s) => ({ pending: s.pending + 1 }));
  const waking = setTimeout(() => useNetStatus.setState({ waking: true }), WAKING_AFTER_MS);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new NetworkError('The server took too long to answer')),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(waking);
    clearTimeout(timeout);
    useNetStatus.setState((s) => {
      const pending = Math.max(0, s.pending - 1);
      return { pending, waking: pending > 0 ? s.waking : false };
    });
  }
}
