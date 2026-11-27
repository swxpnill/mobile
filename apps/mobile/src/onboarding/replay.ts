import type { Role } from '@tonnage/shared';
import { firstTab } from '../nav/tabs';
import { onboardingStore } from './store';
import { tourStore } from './tourStore';
import { rearmWelcome } from './welcome';

/**
 * Demo tools: this person's welcome, intro, tour and tips as on their first sign-in. Shows the
 * welcome now (the intro follows it) over their first tab. Other people's progress is untouched.
 */
export function replayFirstSignIn(
  me: { id: string; role: Role },
  router: { navigate(href: string): void },
): void {
  onboardingStore.getState().reset(me.id);
  rearmWelcome();
  const tour = tourStore.getState();
  tour.end();
  tour.hideTip();
  router.navigate(`/${firstTab(me.role)}`);
  tour.showWelcome();
}
