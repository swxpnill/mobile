import { create } from 'zustand';
import type { Rect } from './geometry';
import type { TargetId } from './tours';

interface TargetsState {
  rects: Partial<Record<TargetId, Rect>>;
  /** Bumped when every target should measure again (a step changed, the window resized). */
  tick: number;
  set(id: TargetId, rect: Rect): void;
  clear(id: TargetId): void;
  bump(): void;
}

const same = (a: Rect | undefined, b: Rect) =>
  !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const targetsStore = create<TargetsState>((set, get) => ({
  rects: {},
  tick: 0,
  set(id, rect) {
    if (same(get().rects[id], rect)) return;
    set({ rects: { ...get().rects, [id]: rect } });
  },
  clear(id) {
    if (!(id in get().rects)) return;
    const rects = { ...get().rects };
    delete rects[id];
    set({ rects });
  },
  bump() {
    set({ tick: get().tick + 1 });
  },
}));

export function useTourTick(): number {
  return targetsStore((s) => s.tick);
}
