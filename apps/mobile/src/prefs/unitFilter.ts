import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { useCompanies } from '../api/hooks/companies';
import { useMe } from '../api/hooks/me';

/** Device storage for the unit switcher (spec §8.2): one choice per person on this phone. */
export const UNIT_FILTER_KEY = 'tonnage.unitFilter';

export type UnitFilter = string | 'all';

interface UnitFilterState {
  /** userId → companyId or 'all'. Per person, so a demo switch or a shared phone never leaks it. */
  byUser: Record<string, UnitFilter>;
  hydrated: boolean;
  set(userId: string, companyId: UnitFilter): void;
  hydrate(): Promise<void>;
}

function persist(byUser: Record<string, UnitFilter>): void {
  void AsyncStorage.setItem(UNIT_FILTER_KEY, JSON.stringify(byUser)).catch(() => undefined);
}

export const unitFilterStore = create<UnitFilterState>((set, get) => ({
  byUser: {},
  hydrated: false,
  set(userId, companyId) {
    const byUser = { ...get().byUser, [userId]: companyId };
    set({ byUser });
    persist(byUser);
  },
  async hydrate() {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(UNIT_FILTER_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const clean = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        );
        // A choice made before hydration finished wins over the stored one.
        set({ byUser: { ...clean, ...get().byUser } });
      }
    } catch {
      // Unreadable storage: start from "All units".
    } finally {
      set({ hydrated: true });
    }
  },
}));

void unitFilterStore.getState().hydrate();

export function resetUnitFilterForTests(): void {
  unitFilterStore.setState({ byUser: {}, hydrated: false });
}

/**
 * The unit (company) every screen filters to, for the signed-in person. Falls back to "All units"
 * while the profile or companies load, and when the remembered company is no longer visible to
 * them (deactivated, or plants changed).
 */
export function useUnitFilter(): { companyId: UnitFilter; set(companyId: UnitFilter): void } {
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const stored = unitFilterStore((s) => (me ? s.byUser[me.id] : undefined));
  const setFor = unitFilterStore((s) => s.set);
  const visible =
    stored !== undefined && stored !== 'all' && (companies?.some((c) => c.id === stored && c.active) ?? false);
  return {
    companyId: visible ? stored : 'all',
    set(companyId) {
      if (me) setFor(me.id, companyId);
    },
  };
}
