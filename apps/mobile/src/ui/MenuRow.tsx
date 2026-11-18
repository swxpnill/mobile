import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import type { Tokens } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Row } from './layout';
import { Text } from './Text';

export type Tone = 'bl' | 'vi' | 'gr' | 'am' | 'rd' | 'te' | 'gy';

const TONE: Record<Tone, { bg: keyof Tokens; fg: keyof Tokens }> = {
  bl: { bg: 'brs', fg: 'brt' },
  vi: { bg: 'vis', fg: 'vi' },
  gr: { bg: 'oks', fg: 'okt' },
  am: { bg: 'wns', fg: 'wnt' },
  rd: { bg: 'dgs', fg: 'dgt' },
  te: { bg: 'tes', fg: 'te' },
  gy: { bg: 'ctl', fg: 'tx2' },
};

/** Coloured 36 px icon tile (canvas `.tile`). */
export function IconTile({ icon, tone, size = 36 }: { icon: IconName; tone: Tone; size?: number }) {
  const { t } = useTheme();
  const c = TONE[tone];
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: size * 0.3, backgroundColor: t[c.bg] },
      ]}
    >
      <Icon name={icon} size={size / 2} color={t[c.fg]} />
    </View>
  );
}

/** A menu line: icon tile, label, optional value, chevron. "Coming soon" rows are greyed out. */
export function MenuRow({
  icon,
  tone,
  label,
  value,
  onPress,
  comingSoon,
  danger,
  badge,
  accessibilityLabel,
}: {
  icon: IconName;
  tone: Tone;
  label: string;
  value?: string;
  onPress?: () => void;
  comingSoon?: boolean;
  danger?: boolean;
  /** A count that needs action (red pill), e.g. open rejections; hidden at 0. */
  badge?: number;
  /** Spoken name when the label alone is not enough (e.g. "Sign out, 2 weights not sent yet"). */
  accessibilityLabel?: string;
}) {
  const { t } = useTheme();
  return (
    <Row
      onPress={onPress ?? (() => undefined)}
      disabled={comingSoon}
      accessibilityLabel={accessibilityLabel ?? (comingSoon ? `${label}, coming soon` : label)}
    >
      <IconTile icon={icon} tone={tone} />
      <Text weight="medium" color={danger ? 'dgt' : 'tx'} style={styles.fill} numberOfLines={1}>
        {label}
      </Text>
      {comingSoon ? (
        <Text variant="caption">Coming soon</Text>
      ) : value ? (
        <Text variant="caption">{value}</Text>
      ) : null}
      {badge ? (
        <View style={[styles.badge, { backgroundColor: t.dgs }]}>
          <Text weight="semibold" color="dgt" numeric style={styles.badgeText}>
            {String(badge)}
          </Text>
        </View>
      ) : null}
      {danger || comingSoon ? null : <Icon name="chevronRight" size={18} color={t.tx3} />}
    </Row>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
  badge: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 13, lineHeight: 18 },
});
