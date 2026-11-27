import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { useMe } from '../api/hooks/me';

/**
 * Welcome, tour and tip progress (canvas 41–46), per person on this phone. Not on the server: a
 * new phone shows the intro again, which suits staff who change phones (design 2026-11-27).
 */
export const ONBOARDING_KEY = 'tonnage.onboarding';

export interface PersonProgress {
  introSeen: boolean;
  tourDone: boolean;
  tipsOn: boolean;
  tipsSeen: string[];
}

export const DEFAULT_PROGRESS: PersonProgress = {
  introSeen: false,
  tourDone: false,
  tipsOn: true,
  tipsSeen: [],
};

interface OnboardingState {
  byUser: Record<string, PersonProgress>;
  hydrated: boolean;
  /** Bottom sheets open right now: tours and tips wait while any is up. */
  openSheets: number;
  hydrate(): Promise<void>;
  update(userId: string, patch: Partial<PersonProgress>): void;
  markTipSeen(userId: string, key: string): void;
  /** One person, or everyone when no id is given. */
  reset(userId?: string): void;
  sheetOpened(): void;
  sheetClosed(): void;
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function sanitizeOne(raw: unknown): PersonProgress | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    introSeen: bool(r.introSeen, DEFAULT_PROGRESS.introSeen),
    tourDone: bool(r.tourDone, DEFAULT_PROGRESS.tourDone),
    tipsOn: bool(r.tipsOn, DEFAULT_PROGRESS.tipsOn),
    tipsSeen: Array.isArray(r.tipsSeen)
      ? [...new Set(r.tipsSeen.filter((x): x is string => typeof x === 'string'))]
      : [],
  };
}

function sanitize(raw: unknown): Record<string, PersonProgress> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PersonProgress> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = sanitizeOne(v);
    if (p) out[id] = p;
  }
  return out;
}

function persist(byUser: Record<string, PersonProgress>): void {
  void AsyncStorage.setItem(ONBOARDING_KEY, JSON.stringify(byUser)).catch(() => undefined);
}

export const onboardingStore = create<OnboardingState>((set, get) => ({
  byUser: {},
  hydrated: false,
  openSheets: 0,
  async hydrate() {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(ONBOARDING_KEY);
      const stored = sanitize(raw ? JSON.parse(raw) : {});
      // A change made before hydration finished wins over the stored one.
      set({ byUser: { ...stored, ...get().byUser } });
    } catch {
      // Unreadable storage: start as if nothing has been seen.
    } finally {
      set({ hydrated: true });
    }
  },
  update(userId, patch) {
    const current = get().byUser[userId] ?? DEFAULT_PROGRESS;
    const byUser = { ...get().byUser, [userId]: { ...current, ...patch } };
    set({ byUser });
    persist(byUser);
  },
  markTipSeen(userId, key) {
    const current = get().byUser[userId] ?? DEFAULT_PROGRESS;
    if (current.tipsSeen.includes(key)) return;
    get().update(userId, { tipsSeen: [...current.tipsSeen, key] });
  },
  reset(userId) {
    const byUser = userId === undefined ? {} : { ...get().byUser };
    if (userId !== undefined) delete byUser[userId];
    set({ byUser });
    persist(byUser);
  },
  sheetOpened() {
    set({ openSheets: get().openSheets + 1 });
  },
  sheetClosed() {
    set({ openSheets: Math.max(0, get().openSheets - 1) });
  },
}));

void onboardingStore.getState().hydrate();

export function resetOnboardingForTests(): void {
  onboardingStore.setState({ byUser: {}, hydrated: false, openSheets: 0 });
}

/** The signed-in person's progress (defaults until loaded), with their id. */
export function useProgress(): PersonProgress & { userId?: string; hydrated: boolean } {
  const { data: me } = useMe();
  const hydrated = onboardingStore((s) => s.hydrated);
  const p = onboardingStore((s) => (me ? s.byUser[me.id] : undefined));
  return { ...(p ?? DEFAULT_PROGRESS), userId: me?.id, hydrated };
}
