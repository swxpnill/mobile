import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Group, Icon, type IconName, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';

export interface OrderAction {
  key: string;
  icon: IconName;
  title: string;
  detail: string;
  danger?: boolean;
  onPress(): void;
}

/** Canvas board 30: the order's actions, already filtered to what this person may do. */
export function OrderActionsSheet({
  visible,
  title,
  subtitle,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle: string;
  actions: OrderAction[];
  onClose(): void;
}) {
  const { t } = useTheme();
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <Text variant="caption" style={styles.sub}>
        {subtitle}
      </Text>
      <Group>
        {actions.map((a) => (
          <Pressable
            key={a.key}
            accessibilityRole="button"
            accessibilityLabel={`${a.title}. ${a.detail}`}
            onPress={() => {
              onClose();
              a.onPress();
            }}
            style={({ pressed }) => [styles.row, { borderBottomColor: t.bd }, pressed ? { backgroundColor: t.act } : null]}
          >
            <View style={[styles.tile, { backgroundColor: a.danger ? t.dgs : t.brs }]}>
              <Icon name={a.icon} size={18} color={a.danger ? t.dgt : t.brt} />
            </View>
            <View style={styles.fill}>
              <Text weight="medium" color={a.danger ? 'dgt' : 'tx'}>
                {a.title}
              </Text>
              <Text variant="caption">{a.detail}</Text>
            </View>
          </Pressable>
        ))}
      </Group>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: -8, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth },
  tile: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
});
