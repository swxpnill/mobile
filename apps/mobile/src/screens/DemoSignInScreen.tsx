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
  const [controls, setControls] = useState<MockControls | null>(null);

  useEffect(() => {
    let live = true;
    void getMockControls().then((c) => live && setControls(c));
    return () => {
      live = false;
    };
  }, []);

  return (
    <Screen title="Sign in as" header={<BackHeader />}>
      <Text color="tx2">Demo data on this phone. No code needed.</Text>
      {controls ? (
        <DemoPeopleList controls={controls} />
      ) : (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      )}
    </Screen>
  );
}
