import '../src/polyfills'; // must run before anything that generates ids
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { metaSchema } from '@tonnage/shared';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, needsForceUpdate } from '../src/api/client';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { useIdleLock } from '../src/auth/lock';
import { useSession } from '../src/auth/session';
import { LockScreen } from '../src/screens/LockScreen';
import { UpdateRequiredScreen } from '../src/screens/UpdateRequiredScreen';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { WakingBanner } from '../src/ui/WakingBanner';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// React Native has no window focus: refetch stale data when the app comes back to the foreground.
focusManager.setEventListener((setFocused) => {
  const sub = AppState.addEventListener('change', (s) => setFocused(s === 'active'));
  return () => sub.remove();
});

function AppShell({ updateRequired }: { updateRequired: boolean }) {
  const { t } = useTheme();
  const status = useSession((s) => s.status);
  const onActivity = useIdleLock();

  if (updateRequired) return <UpdateRequiredScreen />;
  const locked = status === 'locked';
  // The app stays mounted under the lock, so unlocking returns to exactly where the user was
  // (navigation and half-filled forms). While locked it is hidden from screen readers.
  return (
    <View style={styles.fill}>
      <View
        style={styles.fill}
        onTouchStart={onActivity}
        importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={locked}
      >
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: t.bg },
            animation: 'slide_from_right',
          }}
        />
        <WakingBanner />
      </View>
      {locked ? <LockScreen /> : null}
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });
  const fontsDone = fontsLoaded || Boolean(fontError); // a font failure falls back to the system font
  const [themeReady, setThemeReady] = useState(false);
  const status = useSession((s) => s.status);
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => {
    void useSession
      .getState()
      .init()
      .catch(() => useSession.setState({ status: 'signedOut' }));
    // Force-update check. Any failure (offline, server down) must never block the app.
    void api('/v1/meta', { auth: false, schema: metaSchema })
      .then((m) =>
        setUpdateRequired(
          needsForceUpdate(Constants.expoConfig?.version ?? '', m.minSupportedVersion),
        ),
      )
      .catch(() => undefined);
  }, []);

  const ready = fontsDone && themeReady && status !== 'loading';
  useEffect(() => {
    // Keep the splash until fonts, the stored theme and the session are all known: no flash of
    // the wrong theme and no flash of the sign-in screen for a signed-in user.
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider onReady={() => setThemeReady(true)}>
          <UnitBasisProvider>
            {ready ? <AppShell updateRequired={updateRequired} /> : null}
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
