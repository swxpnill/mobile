import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { HowTo } from '../../onboarding/howTo';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';

/** One "How do I…" answer: numbered steps, and "Show me" when there is a screen to open. */
export function HowToSheet({ topic, onClose }: { topic: HowTo | null; onClose(): void }) {
  const { t } = useTheme();
  const router = useRouter();
  return (
    <Sheet visible={topic !== null} title={topic?.title ?? ''} onClose={onClose}>
      {topic ? (
        <>
          <View style={styles.steps}>
            {topic.steps.map((step, i) => (
              <View key={step} style={styles.step} accessible accessibilityLabel={`Step ${i + 1}. ${step}`}>
                <View style={[styles.num, { backgroundColor: t.brs }]}>
                  <Text weight="semibold" numeric style={{ color: t.brt }}>
                    {String(i + 1)}
                  </Text>
                </View>
                <Text style={styles.fill}>{step}</Text>
              </View>
            ))}
          </View>
          {topic.showMe ? (
            <Button
              onPress={() => {
                const to = topic.showMe!;
                onClose();
                router.push(to);
              }}
            >
              Show me
            </Button>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  steps: { gap: 14 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0, paddingTop: 4 },
});
