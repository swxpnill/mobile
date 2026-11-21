import { can } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useMe } from '../../api/hooks/me';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH } from '../../theme/tokens';
import { Icon, IconButton, IconTile, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { type CreateOption, createOptionsFor } from './createOptions';

/**
 * Canvas board 39: what the New tab opens. Tiles the person may not use are not shown; choosing
 * one closes the sheet and opens its screen.
 */
export function CreateSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const router = useRouter();
  const { data: me } = useMe();
  const options = me ? createOptionsFor((a) => can(me.role, a)) : [];
  const choose = (o: CreateOption) => {
    onClose();
    router.push(o.href);
  };
  return (
    <Sheet
      visible={visible}
      title="Create new"
      onClose={onClose}
      header={
        <View style={styles.head}>
          <View style={styles.fill}>
            <Text variant="subtitle" weight="semibold" accessibilityRole="header">
              Create new
            </Text>
            <Text variant="caption">What do you want to add?</Text>
          </View>
          <IconButton icon="close" label="Close" onPress={onClose} />
        </View>
      }
    >
      <View style={styles.grid}>
        {options.map((o) => (
          <Tile key={o.key} o={o} onPress={() => choose(o)} />
        ))}
      </View>
    </Sheet>
  );
}

function Tile({ o, onPress }: { o: CreateOption; onPress(): void }) {
  const { t } = useTheme();
  const lead = o.tone === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${o.label}. ${o.caption}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        o.wide ? styles.wide : styles.half,
        lead
          ? { backgroundColor: pressed ? t.brt : t.inv }
          : { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd, borderWidth: 1 },
      ]}
    >
      {lead ? (
        <View style={[styles.well, { backgroundColor: t.invsoft }]}>
          <Icon name={o.icon} size={22} color={t.invtx} />
        </View>
      ) : (
        <IconTile icon={o.icon} tone={o.tone as Exclude<CreateOption['tone'], 'primary'>} size={40} />
      )}
      <View style={o.wide ? styles.fill : null}>
        <Text weight="semibold" style={lead ? { fontSize: 16, color: t.invtx } : null}>
          {o.label}
        </Text>
        <Text variant="caption" style={lead ? { color: t.invtx2 } : null}>
          {o.caption}
        </Text>
      </View>
      {lead ? <Icon name="chevronRight" size={20} color={t.invtx} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fill: { flex: 1, minWidth: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { borderRadius: 16, padding: 16, gap: 12, minHeight: MIN_TOUCH },
  half: { flexBasis: '47%', flexGrow: 1, minHeight: 118 },
  wide: { flexBasis: '100%', flexDirection: 'row', alignItems: 'center' },
  well: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
