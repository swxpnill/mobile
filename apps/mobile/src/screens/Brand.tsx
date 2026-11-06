import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from '../ui';

/** The "T" tile with the app name and tagline (canvas Sign in artboard). */
export function Brand() {
  const { t } = useTheme();
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel="Tonnage. Order and dispatch for steel units"
    >
      <View style={[styles.tile, { backgroundColor: t.inv }]}>
        <Text weight="semibold" style={{ color: t.invtx, fontSize: 20, letterSpacing: -0.4 }}>
          T
        </Text>
      </View>
      <View>
        <Text variant="heading">Tonnage</Text>
        <Text variant="caption">Order &amp; dispatch for steel units</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tile: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
