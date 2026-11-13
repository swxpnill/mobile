import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { Icon } from './Icon';

/** `value` after it stopped changing for `ms` (search-as-you-type without a request per key). */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** Canvas search box: magnifier, placeholder, and a clear button once something is typed. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  label,
}: {
  value: string;
  onChangeText(v: string): void;
  placeholder: string;
  /** Spoken label; defaults to the placeholder. */
  label?: string;
}) {
  const { t } = useTheme();
  return (
    <View style={[styles.box, { backgroundColor: t.card, borderColor: t.bd2 }]}>
      <Icon name="search" size={18} color={t.tx3} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.tx3}
        accessibilityLabel={label ?? placeholder}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        style={[styles.input, { color: t.tx }]}
      />
      {value !== '' ? (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={12}
        >
          <Icon name="close" size={18} color={t.tx3} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    minHeight: 48,
    borderRadius: radius.input,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
  },
  input: { flex: 1, minWidth: 0, fontSize: 15, paddingVertical: 10, fontFamily: 'Inter_400Regular' },
});
