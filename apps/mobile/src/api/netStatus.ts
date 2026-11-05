import { create } from 'zustand';

/** Requests in flight, and whether one has been pending long enough to say "Waking server…". */
export const useNetStatus = create<{ pending: number; waking: boolean }>(() => ({
  pending: 0,
  waking: false,
}));

/** After this long without a response, show the "Waking server…" banner (free-tier cold start). */
export const WAKING_AFTER_MS = 5_000;
