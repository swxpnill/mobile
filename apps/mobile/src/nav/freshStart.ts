import { CommonActions } from 'expo-router/react-navigation';
import type { TabKey } from './tabs';

type ResetState = Parameters<typeof CommonActions.reset>[0];

interface StackNavigation {
  getState(): unknown;
  dispatch(action: ReturnType<typeof CommonActions.reset>): void;
}

/**
 * After the signed-in person changes without signing out (Demo tools → Sign in as), replace the
 * whole signed-in stack with one fresh tabs screen on the new person's first tab.
 *
 * A plain `router.replace` keeps the previous person's tab container and its history (a
 * supervisor's Profile, tabs the new role does not have), so Android Back would wander through
 * them instead of leaving the app. `navigation` is the stack that holds the `(tabs)` group.
 *
 * This router only accepts a complete state on RESET (key, routeNames, routeKeySeq, stale:
 * false), so the payload is the stack's current state with its routes swapped. The new `(tabs)`
 * route's state holds only the first tab (this router ignores `params.screen`), so the tab
 * navigator starts fresh there.
 */
export function freshStartOn(navigation: StackNavigation, tab: TabKey): void {
  const current = navigation.getState() as Exclude<ResetState, undefined>;
  navigation.dispatch(
    CommonActions.reset({
      ...current,
      index: 0,
      routes: [{ name: '(tabs)', state: { index: 0, routes: [{ name: tab }] } }],
      stale: false,
    } as ResetState),
  );
}
