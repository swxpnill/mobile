import '../src/polyfills'; // must run before anything that generates ids
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { metaSchema } from '@tonnage/shared';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, needsForceUpdate } from '../src/api/client';
import { useNetStatus } from '../src/api/netStatus';
import { useIdleLock } from '../src/auth/lock';
import { useSession } from '../src/auth/session';
import { LockScreen } from '../src/screens/LockScreen';
import { UpdateRequiredScreen } from '../src/screens/UpdateRequiredScreen';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { Text } from '../src/ui';

void SplashScreen.preventAutoHideAsync();

/** "Waking server…" while a request has been pending for 5 s (free-tier cold start). */
function WakingBanner() {
  const waking = useNetStatus((s) => s.waking);
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  if (!waking) return null;
  return (
    <View
      style={[styles.banner, { top: insets.top + 8, backgroundColor: t.tx }]}
      accessibilityLiveRegion="polite"
    >
      <Text weight="medium" style={{ color: t.bg, fontSize: 13 }}>
        Waking server…
      </Text>
    </View>
  );
}

function AppShell({ updateRequired }: { updateRequired: boolean }) {
  const { t } = useTheme();
  const status = useSession((s) => s.status);
  const onActivity = useIdleLock();

  if (updateRequired) return <UpdateRequiredScreen />;
  if (status === 'locked') return <LockScreen />;
  return (
    <View style={styles.fill} onTouchStart={onActivity}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
          animation: 'slide_from_right',
        }}
      />
      <WakingBanner />
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
      <ThemeProvider onReady={() => setThemeReady(true)}>
        {ready ? <AppShell updateRequired={updateRequired} /> : null}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
});
