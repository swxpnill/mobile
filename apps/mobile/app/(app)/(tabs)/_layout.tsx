import { Redirect, Tabs, useSegments } from 'expo-router';
import { useState } from 'react';
import { useMe } from '../../../src/api/hooks/me';
import { type TabKey, tabOrder, tabsForRole, TAB_META } from '../../../src/nav/tabs';
import { LoadError, LoadingScreen } from '../../../src/screens/Loading';
import { CreateSheet } from '../../../src/screens/create/CreateSheet';
import { TabBar } from '../../../src/ui';

const ALL_TABS = Object.keys(TAB_META) as TabKey[];

/**
 * Bottom tabs for the signed-in user's role. Tabs of other roles stay hidden (href: null), and
 * landing on one — e.g. "/" sends everyone to "/home" — redirects to the role's first tab.
 * "New" is not a destination: it opens the Create new sheet over the current tab (board 39).
 */
export default function TabsLayout() {
  const { data: me, error, refetch } = useMe();
  const segments = useSegments();
  const [creating, setCreating] = useState(false);

  if (!me)
    return error ? <LoadError error={error} onRetry={() => void refetch()} /> : <LoadingScreen />;

  const allowed = tabsForRole(me.role);
  const current = segments.at(-1) as TabKey | undefined;
  if (current && ALL_TABS.includes(current) && !allowed.includes(current)) {
    return <Redirect href={`/${allowed[0]}`} />;
  }

  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false }}
        tabBar={({ state, navigateToTab }) => (
          <TabBar
            tabs={allowed}
            active={state.routes[state.index]?.name as TabKey | undefined}
            onPress={(tab) => {
              // This custom bar emits no tabPress event, so the New press is caught here.
              if (tab === 'new') return setCreating(true);
              const route = state.routes.find((r) => r.name === tab);
              if (route) navigateToTab(route.key);
            }}
          />
        )}
      >
        {/*
        The role's own tabs are declared first: the tab router sends Back to the first declared
        route, so declaring Home first left supervisors bouncing between a hidden Home and the
        redirect — they could never leave the app with Back.
      */}
        {tabOrder(me.role).map((tab) => (
          <Tabs.Screen
            key={tab}
            name={tab}
            options={{ href: allowed.includes(tab) ? undefined : null }}
          />
        ))}
      </Tabs>
      <CreateSheet visible={creating} onClose={() => setCreating(false)} />
    </>
  );
}
