import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { SMALL_TEXT_MAX_SCALE, type Tokens } from '../theme/tokens';
import { Text } from './Text';

export interface SegmentedControlProps<T extends string> {
  /** `detail` is a small second line ("84.000 MT", "Broker"), in `detailColor` when given. */
  options: readonly { value: T; label: string; detail?: string; detailColor?: keyof Tokens }[];
  value: T;
  onChange(value: T): void;
  /** `compact` sits inside a settings row (30 high); `full` spans the width (38 high). */
  size?: 'compact' | 'full';
  accessibilityLabel?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'compact',
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  const { t } = useTheme();
  const full = size === 'full';
  const twoLine = options.some((o) => o.detail !== undefined);
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.track, { backgroundColor: t.ctl, borderRadius: full ? 12 : 10 }]}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityLabel={o.detail ? `${o.label}, ${o.detail}` : o.label}
            accessibilityState={{ selected, checked: selected }}
            // Hit areas reach the 44 minimum: the compact segment is 30 high, the full one 38.
            hitSlop={full ? { top: 3, bottom: 3 } : { top: 7, bottom: 7 }}
            onPress={() => {
              if (!selected) onChange(o.value);
            }}
            style={[
              full ? styles.full : styles.compact,
              twoLine ? styles.twoLine : null,
              selected ? [styles.on, { backgroundColor: t.card, shadowColor: t.shadow }] : null,
            ]}
          >
            <Text
              weight="medium"
              color={selected ? 'tx' : 'tx2'}
              style={twoLine ? { fontSize: 13, lineHeight: 16 } : { fontSize: full ? 13 : 12 }}
              numberOfLines={1}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
            >
              {o.label}
            </Text>
            {o.detail ? (
              <Text
                weight="medium"
                color={o.detailColor ?? 'tx3'}
                style={styles.detail}
                numberOfLines={1}
                maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              >
                {o.detail}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 3, gap: 2 },
  compact: {
    minHeight: 30,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    justifyContent: 'center',
  },
  full: {
    flex: 1,
    minHeight: 38,
    paddingVertical: 6,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Canvas 40: two-line segments are a full 44 high. */
  twoLine: { minHeight: 44, paddingHorizontal: 8 },
  detail: { fontSize: 11, lineHeight: 14 },
  on: {
    shadowOpacity: 0.08,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
});
