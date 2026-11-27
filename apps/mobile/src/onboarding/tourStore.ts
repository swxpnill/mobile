import { create } from 'zustand';
import type { TargetId, TourStep } from './tours';

/** What the onboarding layer shows over the app, one at a time (lock > welcome > intro > tour > tip). */
export type Overlay = 'none' | 'welcome' | 'intro' | 'tour' | 'tip';

export interface ActiveTour {
  steps: TourStep[];
  index: number;
  /** Another role's tour from Help & tour: no spotlight, nothing is saved. */
  preview: boolean;
  /** The person whose progress a finish or skip is saved to. */
  userId?: string;
  /** Last button: "Start using Tonnage", "Start weighing" or "Close". */
  lastLabel: string;
}

interface TourState {
  welcome: boolean;
  intro: boolean;
  tour: ActiveTour | null;
  tip: TargetId | null;
  showWelcome(): void;
  hideWelcome(): void;
  setIntro(on: boolean): void;
  begin(t: ActiveTour): void;
  go(index: number): void;
  /** Ends the tour; returns it so the caller can record the finish. */
  end(): ActiveTour | null;
  showTip(key: TargetId): void;
  hideTip(): void;
}

export const tourStore = create<TourState>((set, get) => ({
  welcome: false,
  intro: false,
  tour: null,
  tip: null,
  showWelcome: () => set({ welcome: true }),
  hideWelcome: () => set({ welcome: false }),
  setIntro: (on) => set({ intro: on }),
  begin: (tour) => set({ tour, intro: false, tip: null }),
  go(index) {
    const t = get().tour;
    if (t) set({ tour: { ...t, index: Math.max(0, Math.min(index, t.steps.length - 1)) } });
  },
  end() {
    const t = get().tour;
    set({ tour: null });
    return t;
  },
  showTip: (tip) => set({ tip }),
  hideTip: () => set({ tip: null }),
}));

/** Which overlay is up, by precedence. The lock screen sits above all of it (app shell). */
export function overlayOf(s: Pick<TourState, 'welcome' | 'intro' | 'tour' | 'tip'>): Overlay {
  if (s.welcome) return 'welcome';
  if (s.intro) return 'intro';
  if (s.tour) return 'tour';
  if (s.tip) return 'tip';
  return 'none';
}

export function useOverlay(): Overlay {
  return tourStore(overlayOf);
}

let notificationAt = 0;
/** A welcome due within this long of a tapped notification is skipped (one opened while locked). */
export const NOTIFICATION_SKIP_MS = 10_000;

/** A tapped notification goes straight to its link: the welcome must not sit on top of it. */
export function dismissWelcome(): void {
  notificationAt = Date.now();
  tourStore.getState().hideWelcome();
}

/** True when a notification was just tapped, so a welcome due now would cover its link. */
export function notificationJustOpened(): boolean {
  return Date.now() - notificationAt < NOTIFICATION_SKIP_MS;
}

export function resetTourForTests(): void {
  notificationAt = 0;
  tourStore.setState({ welcome: false, intro: false, tour: null, tip: null });
}
