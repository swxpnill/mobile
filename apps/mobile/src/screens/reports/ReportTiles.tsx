import { REPORT_KINDS, type ReportKind } from '@tonnage/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { radius } from '../../theme/tokens';
import { IconTile, Text } from '../../ui';
import { REPORT_META } from './reportMeta';

/** Board 23: the report kinds as a two-column grid; the selected one is outlined. */
export const ReportTiles = memo(function ReportTiles({
  selected,
  onSelect,
}: {
  selected: ReportKind;
  onSelect(kind: ReportKind): void;
}) {
  const pairs: ReportKind[][] = [];
  for (let i = 0; i < REPORT_KINDS.length; i += 2) pairs.push(REPORT_KINDS.slice(i, i + 2));
  return (
    <View style={styles.grid}>
      {pairs.map((pair) => (
        <View key={pair[0]} style={styles.row}>
          {pair.map((k) => (
            <Tile key={k} kind={k} selected={k === selected} onSelect={onSelect} />
          ))}
          {pair.length === 1 ? <View style={styles.fill} /> : null}
        </View>
      ))}
    </View>
  );
});

const Tile = memo(function Tile({
  kind,
  selected,
  onSelect,
}: {
  kind: ReportKind;
  selected: boolean;
  onSelect(kind: ReportKind): void;
}) {
  const { t } = useTheme();
  const m = REPORT_META[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${m.title}, ${m.caption}`}
      accessibilityState={{ selected }}
      onPress={() => onSelect(kind)}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: pressed ? t.act : t.card,
          borderColor: selected ? t.br : t.bd,
        },
      ]}
    >
      <IconTile icon={m.icon} tone={m.tone} />
      <View>
        <Text weight="medium">{m.title}</Text>
        <Text variant="caption">{m.caption}</Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  grid: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  fill: { flex: 1 },
  // A 1.5 px border on every tile, so selecting one moves nothing.
  tile: { flex: 1, gap: 12, padding: 13, borderRadius: radius.group, borderWidth: 1.5, minHeight: 44 },
});
