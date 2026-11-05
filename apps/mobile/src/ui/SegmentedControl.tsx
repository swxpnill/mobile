import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

export interface SegmentedControlProps<T extends string> {
  options: readonly { value: T; label: string }[];
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
            accessibilityLabel={o.label}
            accessibilityState={{ selected, checked: selected }}
            // The compact segment is 30 high; the hit area is stretched to the 44 minimum.
            hitSlop={full ? undefined : { top: 7, bottom: 7 }}
            onPress={() => {
              if (!selected) onChange(o.value);
            }}
            style={[
              full ? styles.full : styles.compact,
              selected ? [styles.on, { backgroundColor: t.card }] : null,
            ]}
          >
            <Text
              weight="medium"
              color={selected ? 'tx' : 'tx2'}
              style={{ fontSize: full ? 13 : 12 }}
              numberOfLines={1}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 3, gap: 2 },
  compact: { height: 30, paddingHorizontal: 10, borderRadius: 8, justifyContent: 'center' },
  full: { flex: 1, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  on: {
    shadowColor: '#0B0D12',
    shadowOpacity: 0.08,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
});
