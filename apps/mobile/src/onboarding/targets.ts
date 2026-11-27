import { useWindowDimensions } from 'react-native';
import { create } from 'zustand';
import type { Rect } from './geometry';
import type { TargetId } from './tours';

interface TargetsState {
  rects: Partial<Record<TargetId, Rect>>;
  /** Bumped when every target should measure again (a step changed, the window resized). */
  tick: number;
  /**
   * Where the onboarding layer sits in the window. Targets report window coordinates, and on
   * edge-to-edge Android the window and the layer share neither origin (status bar) nor height.
   */
  frame: Rect | null;
  setFrame(frame: Rect): void;
  set(id: TargetId, rect: Rect): void;
  clear(id: TargetId): void;
  bump(): void;
}

const same = (a: Rect | undefined, b: Rect) =>
  !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const targetsStore = create<TargetsState>((set, get) => ({
  rects: {},
  tick: 0,
  frame: null,
  setFrame(frame) {
    const f = get().frame;
    if (!f || f.x !== frame.x || f.y !== frame.y || f.w !== frame.w || f.h !== frame.h) set({ frame });
  },
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

/** The layer's frame, or the whole window until it has been measured. */
export function useOverlayFrame(): Rect {
  const { width, height } = useWindowDimensions();
  return targetsStore((s) => s.frame) ?? { x: 0, y: 0, w: width, h: height };
}

/** A target's window rect in the layer's own coordinates. */
export function toOverlay(r: Rect, frame: Rect): Rect {
  return { ...r, x: r.x - frame.x, y: r.y - frame.y };
}

export function useTourTick(): number {
  return targetsStore((s) => s.tick);
}
