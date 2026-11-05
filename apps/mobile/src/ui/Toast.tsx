import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

export const TOAST_MS = 4_000;

const useToast = create<{ message: string | null; seq: number }>(() => ({ message: null, seq: 0 }));

/** A short message at the bottom of the screen ("Saved", "Someone else changed this…"). */
export function showToast(message: string): void {
  useToast.setState((s) => ({ message, seq: s.seq + 1 }));
  AccessibilityInfo.announceForAccessibility?.(message);
}

export function hideToast(): void {
  useToast.setState({ message: null });
}

/** Rendered once, above every screen. Each new message restarts the timer. */
export function ToastHost() {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { message, seq } = useToast();

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(hideToast, TOAST_MS);
    return () => clearTimeout(id);
  }, [message, seq]);

  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 96 }]}>
      <View
        testID="toast"
        accessibilityLiveRegion="polite"
        style={[styles.toast, { backgroundColor: t.tx }]}
      >
        <Text weight="medium" style={{ color: t.bg }}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    maxWidth: 480,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
