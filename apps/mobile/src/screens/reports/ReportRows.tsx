import { type UnitBasis, groupIndian, toDisplayQty } from '@tonnage/shared';
import { memo } from 'react';
import { FlatList, Modal, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeProvider';
import { IconButton, Text } from '../../ui';
import type { CompanyLine, ListLine } from './reportView';

/** Board 23 table columns: Unit 1.6 · Net 1 · Trucks 0.7. */
export const COLUMNS = { unit: 1.6, net: 1, trucks: 0.7 } as const;

/** A company line of the register / unit sales table, with its colour dot. */
export const CompanyRow = memo(function CompanyRow({
  line,
  color,
  basis,
}: {
  line: CompanyLine;
  color: string;
  basis: UnitBasis;
}) {
  const { t } = useTheme();
  const net = toDisplayQty(line.netKg, basis);
  return (
    <View
      style={[styles.tr, { borderTopColor: t.bd }]}
      accessible
      accessibilityLabel={`${line.label}, ${toDisplayQty(line.netKg, basis, { withUnit: true })}, ${line.trucks} trucks`}
    >
      <View style={[styles.cell, { flex: COLUMNS.unit }, styles.unit]}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text weight="medium" numberOfLines={1} style={styles.shrink}>
          {line.label}
        </Text>
      </View>
      <Text weight="semibold" numeric style={[styles.right, { flex: COLUMNS.net }]}>
        {net}
      </Text>
      <Text color="tx2" numeric style={[styles.right, { flex: COLUMNS.trucks }]}>
        {groupIndian(String(line.trucks))}
      </Text>
    </View>
  );
});

/** A line of a non-table report: title and caption left, value (and caption) right. */
export const ListRow = memo(function ListRow({ line }: { line: ListLine }) {
  const { t } = useTheme();
  return (
    <View
      style={[styles.li, { borderTopColor: t.bd }]}
      accessible
      accessibilityLabel={[line.title, line.caption, line.value, line.valueCaption].filter(Boolean).join(', ')}
    >
      <View style={styles.shrink}>
        <Text weight="medium" numberOfLines={1}>
          {line.title}
        </Text>
        <Text variant="caption" numberOfLines={2}>
          {line.caption}
        </Text>
      </View>
      <View style={styles.value}>
        <Text weight="semibold" numeric color={line.valueColor}>
          {line.value}
        </Text>
        {line.valueCaption ? (
          <Text variant="caption" numeric>
            {line.valueCaption}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

/** "See all N rows": every row of the report in a virtualised full-screen list. */
export function AllRowsSheet({ title, lines, onClose }: { title: string; lines: readonly ListLine[]; onClose(): void }) {
  const { t } = useTheme();
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaView style={[styles.fill, { backgroundColor: t.bg }]} edges={['top', 'bottom']}>
        <View style={styles.head}>
          <IconButton icon="close" label="Close" onPress={onClose} />
          <Text variant="heading" accessibilityRole="header" style={styles.shrink} numberOfLines={1}>
            {title}
          </Text>
          <Text variant="caption">{`${groupIndian(String(lines.length))} rows`}</Text>
        </View>
        <FlatList
          data={lines}
          keyExtractor={keyOf}
          renderItem={renderLine}
          style={[styles.list, { backgroundColor: t.card, borderColor: t.bd }]}
          initialNumToRender={20}
          windowSize={9}
        />
      </SafeAreaView>
    </Modal>
  );
}

const keyOf = (l: ListLine) => l.key;
const renderLine = ({ item }: { item: ListLine }) => <ListRow line={item} />;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  shrink: { flex: 1, minWidth: 0 },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: 1 },
  cell: { minWidth: 0 },
  unit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 2 },
  right: { textAlign: 'right' },
  li: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: 1, minHeight: 56 },
  value: { alignItems: 'flex-end', maxWidth: '50%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  list: { flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 16, borderWidth: 1 },
});
