import * as Router from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '../api/hooks/me';
import { useSession } from '../auth/session';
import { DEFAULT_PROGRESS, onboardingStore } from './store';
import { intersects } from './geometry';
import { targetsStore, toOverlay, useOverlayFrame } from './targets';
import { overlayOf, tourStore } from './tourStore';
import { tipFor } from './tips';
import type { TargetId } from './tours';

type FocusEffect = (cb: () => void | (() => void)) => void;
/**
 * The router's focus effect; where it is absent (screen tests that stub the router) the screen
 * counts as focused while mounted.
 */
const useFocusEffect: FocusEffect =
  (Router as { useFocusEffect?: FocusEffect }).useFocusEffect ??
  ((cb) => {
    useEffect(cb, [cb]);
  });

/** The screen settles (lists load, sheets finish opening) before its tip is considered. */
export const TIP_SETTLE_MS = 600;

/**
 * Board 45: the first time this screen is focused, one tip about `key`, once per person. It waits
 * while the welcome, intro, a tour or a sheet is up, and is marked seen as soon as it shows, so a
 * killed app never shows it twice. Leaving the screen takes it away.
 */
export function useFirstTip(key: TargetId): void {
  const { data: me } = useMe();
  const [focused, setFocused] = useState(false);
  const status = useSession((s) => s.status);
  const overlay = tourStore(overlayOf);
  const openSheets = onboardingStore((s) => s.openSheets);
  const hydrated = onboardingStore((s) => s.hydrated);
  const progress = onboardingStore((s) => (me ? s.byUser[me.id] : undefined)) ?? DEFAULT_PROGRESS;
  const frame = useOverlayFrame();
  // On screen now, not merely laid out: a tip below the fold would be used up unseen.
  const placed = targetsStore((s) => {
    const r = s.rects[key];
    return !!r && intersects({ w: frame.w, h: frame.h }, toOverlay(r, frame));
  });

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
        if (tourStore.getState().tip === key) tourStore.getState().hideTip();
      };
    }, [key]),
  );

  const eligible =
    focused &&
    hydrated &&
    !!me &&
    status === 'signedIn' &&
    progress.tipsOn &&
    !progress.tipsSeen.includes(key) &&
    !!tipFor(me.role, key) &&
    overlay === 'none' &&
    openSheets === 0 &&
    placed;

  useEffect(() => {
    if (!eligible || !me) return;
    const timer = setTimeout(() => {
      // Still nothing else in the way after the settle time.
      if (overlayOf(tourStore.getState()) !== 'none' || onboardingStore.getState().openSheets > 0) return;
      onboardingStore.getState().markTipSeen(me.id, key);
      tourStore.getState().showTip(key);
    }, TIP_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [eligible, me, key]);
}
