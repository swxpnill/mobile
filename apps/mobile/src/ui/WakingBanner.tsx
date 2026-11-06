import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNetStatus } from '../api/netStatus';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

/** "Waking server…" while a request has been pending for 5 s (free-tier cold start). */
export function WakingBanner() {
  const waking = useNetStatus((s) => s.waking);
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  if (!waking) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.banner, { top: insets.top + 8, backgroundColor: t.tx }]}
      accessibilityLiveRegion="polite"
    >
      <Text weight="medium" style={{ color: t.bg, fontSize: 13 }}>
        Waking server…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
});
