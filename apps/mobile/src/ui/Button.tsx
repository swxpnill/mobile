import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { Text } from './Text';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'danger';
  onPress(): void;
  disabled?: boolean;
  /** Shows a spinner and blocks presses (a request is in flight). */
  loading?: boolean;
  children: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  variant = 'primary',
  onPress,
  disabled,
  loading,
  children,
  style,
}: ButtonProps) {
  const { t } = useTheme();
  const inactive = Boolean(disabled || loading);
  const colors = {
    primary: { bg: t.inv, fg: t.invtx, border: undefined },
    secondary: { bg: t.card, fg: t.tx, border: t.bd2 },
    danger: { bg: t.dgt, fg: '#FFFFFF', border: undefined },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={children}
      accessibilityState={{ disabled: inactive, busy: Boolean(loading) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: colors.bg },
        colors.border ? { borderWidth: 1, borderColor: colors.border } : null,
        disabled && !loading ? styles.disabled : null,
        pressed ? styles.pressed : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.fg} />
      ) : (
        <Text weight="semibold" style={{ color: colors.fg, fontSize: 15 }} numberOfLines={1}>
          {children}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 52,
    borderRadius: radius.button,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
});
