import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH, SMALL_TEXT_MAX_SCALE, type Tokens } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type AvatarTone = 'br' | 'vi' | 'te' | 'wn' | 'nu';

const TONE: Record<AvatarTone, { bg: keyof Tokens; fg: keyof Tokens }> = {
  br: { bg: 'brs', fg: 'brt' },
  vi: { bg: 'vis', fg: 'vi' },
  te: { bg: 'tes', fg: 'te' },
  wn: { bg: 'wns', fg: 'wnt' },
  nu: { bg: 'ctl', fg: 'tx2' },
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** Initials in a tinted circle (canvas Users & roles `.av`). Decorative: rows carry the name. */
export function Avatar({
  name,
  tone,
  size = 40,
}: {
  name: string;
  tone: AvatarTone;
  size?: number;
}) {
  const { t } = useTheme();
  const c = TONE[tone];
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.av,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: t[c.bg] },
      ]}
    >
      <Text
        weight="semibold"
        color={c.fg}
        maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        style={{ fontSize: 13 }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}

/** Round icon button for a header ("Add company"); filled with the brand colour. */
/**
 * Icon-only button with a 44 dp target. Plain (canvas header and row icons) by default;
 * `filled` is the primary round button (e.g. "Add company").
 */
export function IconButton({
  icon,
  label,
  onPress,
  filled,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  filled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        filled ? styles.btn : styles.plain,
        filled ? { backgroundColor: t.inv } : null,
        pressed ? (filled ? { opacity: 0.85 } : { backgroundColor: t.act }) : null,
      ]}
    >
      <Icon name={icon} color={filled ? t.invtx : t.tx2} size={filled ? 20 : 22} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  av: { alignItems: 'center', justifyContent: 'center' },
  plain: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  btn: {
    width: 40,
    height: 40,
    minWidth: MIN_TOUCH - 4,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
});
