import { StyleSheet, View } from 'react-native';
import { useSyncStatus } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import type { Tokens } from '../../theme/tokens';
import { Icon, type IconName, Text } from '../../ui';
import { weights } from './usePlantTitle';

/**
 * Canvas 11 status strip: red when the server refused weights (the owner decides), amber while
 * weights wait on this phone, nothing when everything is synced.
 */
export function SyncBanner() {
  const { t } = useTheme();
  const { online, pending, rejected } = useSyncStatus();

  let tone: { bg: keyof Tokens; fg: keyof Tokens; icon: IconName };
  let title: string;
  let detail: string | null;
  if (rejected > 0) {
    tone = { bg: 'dgs', fg: 'dgt', icon: 'info' };
    title = `${weights(rejected)} need the owner`;
    detail = 'The server did not accept them · the owner checks them';
  } else if (pending > 0 && online === false) {
    tone = { bg: 'wns', fg: 'wnt', icon: 'wifiOff' };
    title = 'No network';
    detail = `${weights(pending)} saved on this phone · they sync automatically`;
  } else if (pending > 0) {
    tone = { bg: 'wns', fg: 'wnt', icon: 'clock' };
    title = `${pending} waiting to sync`;
    detail = 'Saved safely on this phone';
  } else {
    return null;
  }

  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      style={[styles.banner, { backgroundColor: t[tone.bg] }]}
    >
      <Icon name={tone.icon} size={20} color={t[tone.fg]} />
      <View style={styles.fill}>
        <Text weight="medium" color={tone.fg}>
          {title}
        </Text>
        {detail ? (
          <Text variant="caption" color={tone.fg}>
            {detail}
          </Text>
        ) : null}
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
});
