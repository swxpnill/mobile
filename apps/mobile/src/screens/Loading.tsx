import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Button, Text } from '../ui';
import { messageFor } from './messages';

/** Full-screen spinner while the profile loads for the first time. */
export function LoadingScreen() {
  const { t } = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: t.bg }]} accessibilityLabel="Loading">
      <ActivityIndicator color={t.br} />
    </View>
  );
}

/** Profile could not be loaded and nothing is cached (first launch while offline). */
export function LoadError({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const { t } = useTheme();
  return (
    <View style={[styles.center, styles.pad, { backgroundColor: t.bg }]}>
      <Text color="tx2" style={styles.text} accessibilityRole="alert">
        {messageFor(error)}
      </Text>
      <Button onPress={onRetry}>Try again</Button>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { paddingHorizontal: 24, gap: 16 },
  text: { textAlign: 'center' },
});
