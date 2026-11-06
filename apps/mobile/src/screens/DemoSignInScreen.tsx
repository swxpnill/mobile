import type { MockControls } from '@tonnage/mock-api';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { getMockControls } from '../api/demo';
import { useTheme } from '../theme/ThemeProvider';
import { Screen, Text } from '../ui';
import { BackHeader } from './admin/parts';
import { DemoPeopleList } from './DemoPeopleList';

/** From Sign in (mock mode): pick a sample person instead of typing a number and code. */
export function DemoSignInScreen() {
  const { t } = useTheme();
  // undefined = still loading; null = this build has no demo data (or it failed to open).
  const [controls, setControls] = useState<MockControls | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    getMockControls().then(
      (c) => live && setControls(c),
      () => live && setControls(null),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <Screen title="Sign in as" header={<BackHeader />}>
      <Text color="tx2">Demo data on this phone. No code needed.</Text>
      {controls === undefined ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      ) : controls === null ? (
        <Text color="tx2" accessibilityRole="alert">
          Sample people aren't available in this version. Go back and sign in with your mobile
          number.
        </Text>
      ) : (
        <DemoPeopleList controls={controls} />
      )}
    </Screen>
  );
}
