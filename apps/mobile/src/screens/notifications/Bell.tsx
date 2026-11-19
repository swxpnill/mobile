import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useUnreadCount } from '../../api/hooks/notifications';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, SMALL_TEXT_MAX_SCALE } from '../../theme/tokens';
import { Icon, Text } from '../../ui';

/** "9+" past nine, so the badge never grows wider than the bell. */
export const badgeText = (n: number) => (n > 9 ? '9+' : String(n));

/** Home's bell (board 15): opens Notifications; a red count when something is unread. */
export function Bell() {
  const router = useRouter();
  const { t } = useTheme();
  const { data: unread = 0 } = useUnreadCount();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
      onPress={() => router.push('/notifications')}
      hitSlop={4}
      style={({ pressed }) => [styles.btn, pressed ? { backgroundColor: t.act } : null]}
    >
      <Icon name="bell" color={t.tx2} />
      {unread > 0 ? (
        <View style={[styles.badge, { backgroundColor: t.dgf, borderColor: t.bg }]}>
          <Text weight="semibold" numeric maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} style={[styles.count, { color: t.invtx }]}>
            {badgeText(unread)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { fontSize: 10, lineHeight: 12 },
});
