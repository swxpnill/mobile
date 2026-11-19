import { type Notification, type UnitBasis, renderNotification, tileFor } from '@tonnage/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { IconTile, type IconName, Text } from '../../ui';

/** One row of board 37: tile, title, detail, and the unread dot. */
export const NotificationRow = memo(function NotificationRow({
  n,
  basis,
  onPress,
}: {
  n: Notification;
  basis: UnitBasis;
  onPress(n: Notification): void;
}) {
  const { t } = useTheme();
  const { title, body } = renderNotification(n, basis);
  const tile = tileFor(n.kind);
  const unread = n.readAt === null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}${unread ? ', unread' : ''}`}
      onPress={() => onPress(n)}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: t.act } : null]}
    >
      <IconTile icon={tile.icon as IconName} tone={tile.tone} size={38} />
      <View style={styles.text}>
        <Text weight="medium">{title}</Text>
        <Text variant="caption">{body}</Text>
      </View>
      {unread ? <View testID="unread-dot" style={[styles.dot, { backgroundColor: t.br }]} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingVertical: 14, paddingHorizontal: 16, minHeight: 64 },
  text: { flex: 1, minWidth: 0, gap: 2, paddingRight: 16 },
  dot: { position: 'absolute', right: 16, top: 20, width: 8, height: 8, borderRadius: 4 },
});
