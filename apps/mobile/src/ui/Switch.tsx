import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

/** Canvas `.tg`: 44×26 track, white 20 px thumb, `ok` when on. The hit area is stretched to 44. */
export function Switch({
  label,
  value,
  onChange,
  disabled,
}: {
  /** Accessible name; the visible label normally sits beside the switch in the row. */
  label: string;
  value: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
      style={[
        styles.track,
        {
          backgroundColor: value ? t.ok : t.act,
          justifyContent: value ? 'flex-end' : 'flex-start',
        },
        disabled ? styles.disabled : null,
      ]}
    >
      <View style={styles.thumb} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13, padding: 3, flexDirection: 'row' },
  thumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  disabled: { opacity: 0.45 },
});
