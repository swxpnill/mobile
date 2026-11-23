import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface ButtonProps {
  /** `violet`: the tare step's action (canvas `.bv`); `whatsapp`: Send on WhatsApp (token `wa`). */
  variant?: 'primary' | 'secondary' | 'danger' | 'violet' | 'whatsapp';
  /** A leading icon in the text colour. */
  icon?: IconName;
  onPress(): void;
  disabled?: boolean;
  /** Shows a spinner and blocks presses (a request is in flight). */
  loading?: boolean;
  children: string;
  /** What a screen reader says when the visible words need context (default: the words). */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  variant = 'primary',
  onPress,
  disabled,
  loading,
  children,
  accessibilityLabel,
  style,
  icon,
}: ButtonProps) {
  const { t } = useTheme();
  const inactive = Boolean(disabled || loading);
  const colors = {
    primary: { bg: t.inv, fg: t.invtx, border: undefined },
    secondary: { bg: t.card, fg: t.tx, border: t.bd2 },
    danger: { bg: t.dgf, fg: t.onDanger, border: undefined },
    violet: { bg: t.vi, fg: t.vitx, border: undefined },
    whatsapp: { bg: t.wa, fg: t.invtx, border: undefined },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? children}
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
        <>
          {icon ? <Icon name={icon} size={18} color={colors.fg} /> : null}
          <Text weight="semibold" style={{ color: colors.fg, fontSize: 15 }} numberOfLines={1}>
            {children}
          </Text>
        </>
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
