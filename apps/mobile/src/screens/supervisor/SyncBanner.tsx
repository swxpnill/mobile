import { StyleSheet, View } from 'react-native';
import { useSyncStatus } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import type { Tokens } from '../../theme/tokens';
import { Icon, type IconName, Text } from '../../ui';
import { weights } from './usePlantTitle';

type Strip = { tone: { bg: keyof Tokens; fg: keyof Tokens; icon: IconName }; title: string; detail: string };

/**
 * Canvas 11 status strips: red when the server refused weights (the owner decides), amber while
 * weights wait on this phone (both when both apply), nothing when everything is synced.
 */
export function SyncBanner() {
  const { online, pending, rejected } = useSyncStatus();

  const strips: Strip[] = [];
  if (rejected > 0)
    strips.push({
      tone: { bg: 'dgs', fg: 'dgt', icon: 'info' },
      title: `${weights(rejected)} need the owner`,
      detail: 'The server did not accept them · the owner checks them',
    });
  if (pending > 0 && online === false)
    strips.push({
      tone: { bg: 'wns', fg: 'wnt', icon: 'wifiOff' },
      title: 'No network',
      detail: `${weights(pending)} saved on this phone · they sync automatically`,
    });
  else if (pending > 0)
    strips.push({
      tone: { bg: 'wns', fg: 'wnt', icon: 'clock' },
      title: `${pending} waiting to sync`,
      detail: 'Saved safely on this phone',
    });
  if (strips.length === 0) return null;
  if (strips.length === 1) return <BannerStrip {...strips[0]!} />;
  return (
    <View style={styles.stack}>
      {strips.map((s) => (
        <BannerStrip key={s.title} {...s} />
      ))}
    </View>
  );
}

function BannerStrip({ tone, title, detail }: Strip) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${title}. ${detail}`}
      style={[styles.banner, { backgroundColor: t[tone.bg] }]}
    >
      <Icon name={tone.icon} size={20} color={t[tone.fg]} />
      <View style={styles.fill}>
        <Text weight="medium" color={tone.fg}>
          {title}
        </Text>
        <Text variant="caption" color={tone.fg}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  fill: { flex: 1, minWidth: 0 },
  stack: { gap: 8 },
});
