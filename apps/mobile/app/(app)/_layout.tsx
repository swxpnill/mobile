import { Redirect, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSession } from '../../src/auth/session';
import { useVehicleRequestFlusher } from '../../src/api/hooks/vehicleRequests';
import { usePush } from '../../src/notifications/usePush';
import { useBackgroundSync } from '../../src/offline/backgroundSync';
import { useSync } from '../../src/offline/useSync';
import { TourProvider } from '../../src/onboarding/TourProvider';
import { ToastHost } from '../../src/ui';

/**
 * Everything behind sign-in. Signing out (or a refused refresh) lands on sign-in. Capture roles
 * keep their device store in sync while signed in (stops on sign-out and person switch).
 */
export default function AppLayout() {
  const status = useSession((s) => s.status);
  useSync();
  useBackgroundSync();
  usePush();
  useVehicleRequestFlusher();
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return (
    <View style={styles.fill}>
      {/* Welcome, intro, tours and tips (canvas 41–46) over everything signed in; toasts stay on top. */}
      <TourProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </TourProvider>
      <ToastHost />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
