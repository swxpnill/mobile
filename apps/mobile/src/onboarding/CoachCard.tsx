import { type ComponentRef, useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, findNodeHandle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH } from '../theme/tokens';
import { Icon, Text } from '../ui';
import type { TourStep } from './tours';

/** The step card of a tour (canvas 43–44): tag, progress dots, title, body, Back / Next. */
export function CoachCard({
  step,
  index,
  total,
  lastLabel,
  onBack,
  onNext,
  onLayoutHeight,
}: {
  step: TourStep;
  index: number;
  total: number;
  lastLabel: string;
  onBack(): void;
  onNext(): void;
  onLayoutHeight(h: number): void;
}) {
  const { t } = useTheme();
  const titleRef = useRef<ComponentRef<typeof View>>(null);
  const last = index === total - 1;

  // TalkBack: each new step is read from its title.
  useEffect(() => {
    const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [step.id]);

  return (
    <View
      testID="coach-card"
      accessibilityViewIsModal
      accessibilityLabel={`Step ${index + 1} of ${total}`}
      onLayout={(e) => onLayoutHeight(e.nativeEvent.layout.height)}
      style={[styles.card, { backgroundColor: t.card, shadowColor: t.shadow }]}
    >
      <View style={styles.row}>
        <View style={[styles.tag, { backgroundColor: t.brs }]}>
          <Text variant="overline" style={{ color: t.brt }}>
            {step.tag}
          </Text>
        </View>
        <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {Array.from({ length: total }, (_, k) => (
            <View
              key={k}
              style={[
                styles.dot,
                { width: k === index ? 18 : 6, backgroundColor: k === index ? t.inv : t.bd2 },
              ]}
            />
          ))}
        </View>
      </View>
      <View ref={titleRef} accessible accessibilityRole="header" accessibilityLabel={step.title}>
        <Text testID="coach-title" weight="semibold" style={styles.title}>
          {step.title}
        </Text>
      </View>
      <Text color="tx2" style={styles.body}>
        {step.body}
      </Text>
      <View style={styles.actions}>
        {index > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.back} hitSlop={4}>
            <Icon name="back" size={16} color={t.tx2} strokeWidth={2} />
            <Text weight="medium" color="tx2">
              Back
            </Text>
          </Pressable>
        ) : (
          <Text variant="caption">{`Step 1 of ${total}`}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={last ? lastLabel : 'Next'}
          onPress={onNext}
          style={({ pressed }) => [styles.next, { backgroundColor: t.inv, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text weight="semibold" style={{ color: t.invtx }}>
            {last ? lastLabel : 'Next'}
          </Text>
          {last ? null : <Icon name="chevronRight" size={16} color={t.invtx} strokeWidth={2} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    padding: 20,
    gap: 12,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tag: { height: 26, paddingHorizontal: 12, borderRadius: 13, justifyContent: 'center' },
  dots: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  dot: { height: 6, borderRadius: 3 },
  title: { fontSize: 18, lineHeight: 24, letterSpacing: -0.27 },
  body: { lineHeight: 21 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  back: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  next: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 20,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
