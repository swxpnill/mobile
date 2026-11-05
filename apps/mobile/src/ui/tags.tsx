import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, type Tokens, unitTagColors } from '../theme/tokens';
import { Text } from './Text';

export type BadgeKind = 'br' | 'ok' | 'wn' | 'dg' | 'nu' | 'vi' | 'te';

const BADGE: Record<BadgeKind, { bg: keyof Tokens; fg: keyof Tokens }> = {
  br: { bg: 'brs', fg: 'brt' },
  ok: { bg: 'oks', fg: 'okt' },
  wn: { bg: 'wns', fg: 'wnt' },
  dg: { bg: 'dgs', fg: 'dgt' },
  nu: { bg: 'ctl', fg: 'tx2' },
  vi: { bg: 'vis', fg: 'vi' },
  te: { bg: 'tes', fg: 'te' },
};

/** Status pill ("Open", "Partly dispatched", "Invited"). `dot` adds the leading status dot. */
export function Badge({
  kind,
  children,
  dot,
}: {
  kind: BadgeKind;
  children: string;
  dot?: boolean;
}) {
  const { t } = useTheme();
  const c = BADGE[kind];
  return (
    <View style={[styles.badge, { backgroundColor: t[c.bg] }]}>
      {dot ? <View style={[styles.dot, { backgroundColor: t[c.fg] }]} /> : null}
      <Text variant="caption" weight="medium" color={c.fg} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

/** Company code tag (AIP, VSL…). `slot` = the company's index in the code-sorted list. */
export function UnitTag({ code, slot }: { code: string; slot: number }) {
  const { scheme } = useTheme();
  const c = unitTagColors(slot, scheme);
  return (
    <View style={[styles.unit, { backgroundColor: c.bg }]} accessibilityLabel={`Unit ${code}`}>
      <Text
        weight="semibold"
        style={{ color: c.fg, fontSize: 11, lineHeight: 14, letterSpacing: 0.33 }}
      >
        {code}
      </Text>
    </View>
  );
}

/** Filter chip with an optional count ("Open 21"). */
export function Chip({
  label,
  count,
  selected,
  onPress,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onPress(): void;
}) {
  const { t } = useTheme();
  const fg = selected ? t.invtx : t.tx2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: t.inv }
          : { backgroundColor: t.card, borderColor: t.bd, borderWidth: 1 },
      ]}
    >
      <Text weight="medium" style={{ color: fg, fontSize: 13 }}>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text numeric style={{ color: fg, fontSize: 12, opacity: 0.65 }}>
          {String(count)}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: radius.badge,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  unit: {
    height: 20,
    paddingHorizontal: 6,
    borderRadius: radius.tag,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  chip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.chip,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
