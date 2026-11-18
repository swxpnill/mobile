import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH } from '../../theme/tokens';
import { Group, Icon, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';

export interface FilterOption {
  id: string;
  label: string;
}

/** The report's own filter (customer, broker, plant or age): "All …" first, then each option. */
export function FilterSheet({
  title,
  allLabel,
  options,
  value,
  onPick,
  onClose,
}: {
  title: string;
  allLabel: string;
  options: readonly FilterOption[];
  value: string | undefined;
  /** The picked option, or undefined for "All …"; the label is kept for the chip. */
  onPick(option: FilterOption | undefined): void;
  onClose(): void;
}) {
  const pick = (id: string | undefined) => {
    onPick(options.find((o) => o.id === id));
    onClose();
  };
  return (
    <Sheet visible title={title} onClose={onClose}>
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        <Group>
          <Option id={undefined} label={allLabel} checked={value === undefined} onPick={pick} />
          {options.map((o) => (
            <Option key={o.id} id={o.id} label={o.label} checked={value === o.id} onPick={pick} />
          ))}
        </Group>
      </ScrollView>
    </Sheet>
  );
}

const Option = memo(function Option({
  id,
  label,
  checked,
  onPick,
}: {
  id: string | undefined;
  label: string;
  checked: boolean;
  onPick(id: string | undefined): void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={() => onPick(id)}
      style={({ pressed }) => [styles.option, pressed ? { backgroundColor: t.act } : null]}
    >
      <Text weight="medium" style={styles.fill} numberOfLines={1}>
        {label}
      </Text>
      {checked ? <Icon name="check" size={20} color={t.brt} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  fill: { flex: 1, minWidth: 0 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: MIN_TOUCH + 6 },
});
