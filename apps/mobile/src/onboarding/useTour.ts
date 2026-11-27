import type { Role } from '@tonnage/shared';
import { type Href, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { useMe } from '../api/hooks/me';
import { useSession } from '../auth/session';
import { firstTab } from '../nav/tabs';
import { onboardingStore } from './store';
import { targetsStore } from './targets';
import { tourStore } from './tourStore';
import { stepsFor } from './tours';

/** Time for the first tab to lay out before step 1 measures its target. */
export const TOUR_START_DELAY_MS = 300;

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export function useTour(): {
  active: boolean;
  /** The signed-in person is known, so a tour can start. */
  ready: boolean;
  startTour(): void;
  startPreview(role: Role): void;
  stop(): void;
} {
  const router = useRouter();
  const { data: me } = useMe();
  const active = tourStore((s) => s.tour !== null);

  const startTour = useCallback(() => {
    if (!me) return;
    onboardingStore.getState().update(me.id, { introSeen: true });
    tourStore.getState().setIntro(false);
    router.navigate(`/${firstTab(me.role)}` as Href);
    const identity = useSession.getState().identity;
    setTimeout(() => {
      // Signed out or switched person meanwhile: the tour was theirs, not the next person's.
      if (useSession.getState().identity !== identity) return;
      tourStore.getState().begin({
        steps: stepsFor(me.role, firstName(me.name)),
        index: 0,
        preview: false,
        userId: me.id,
        lastLabel: me.role === 'supervisor' ? 'Start weighing' : 'Start using Tonnage',
      });
      targetsStore.getState().bump();
    }, TOUR_START_DELAY_MS);
  }, [me, router]);

  const startPreview = useCallback((role: Role) => {
    // Their screens are not on this phone: the cards alone, and no closing "you're all set".
    const steps = stepsFor(role, '')
      .slice(0, -1)
      .map((s) => ({ ...s, target: undefined }));
    tourStore.getState().begin({ steps, index: 0, preview: true, lastLabel: 'Close' });
  }, []);

  const stop = useCallback(() => {
    tourStore.getState().end();
  }, []);

  return { active, ready: !!me, startTour, startPreview, stop };
}
