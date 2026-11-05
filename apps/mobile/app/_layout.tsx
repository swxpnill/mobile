import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

void SplashScreen.preventAutoHideAsync();

function ThemedStack() {
  const { t } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.bg },
        animation: 'slide_from_right',
      }}
    />
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  const fontsDone = loaded || Boolean(error); // a font failure falls back to the system font
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    // Keep the splash until both fonts and the stored theme are ready: no flash of the wrong
    // theme or text size on cold start.
    if (fontsDone && themeReady) void SplashScreen.hideAsync();
  }, [fontsDone, themeReady]);

  return (
    <SafeAreaProvider>
      <ThemeProvider onReady={() => setThemeReady(true)}>
        {fontsDone ? <ThemedStack /> : null}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
