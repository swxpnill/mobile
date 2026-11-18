import type { LedgerEntry, UnitBasis } from '@tonnage/shared';
import { type ReactElement, memo, useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, type SectionListRenderItem, StyleSheet, View } from 'react-native';
import { dayGroupLabel } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { radius } from '../../theme/tokens';
import { Badge, Icon, Text } from '../../ui';
import { ledgerCaption, ledgerTitle, signedRupees } from './captions';

interface Section {
  title: string;
  data: LedgerEntry[];
}

/** Newest-first entries into day groups ("Today", "Yesterday", "3 Nov"), keeping their order. */
export function groupByDay(entries: readonly LedgerEntry[], today: string): Section[] {
  const out: Section[] = [];
  let last: string | null = null;
  for (const e of entries) {
    if (e.entryDate !== last) {
      out.push({ title: dayGroupLabel(e.entryDate, today), data: [] });
      last = e.entryDate;
    }
    out[out.length - 1]!.data.push(e);
  }
  return out;
}

/**
 * Board 06's ledger as one virtualised list: the profile above it is the list header, day groups
 * are sections, each a card of rows. The next page loads near the end.
 */
export function LedgerList({
  entries,
  basis,
  today,
  header,
  empty,
  onEndReached,
  loadingMore,
  onPressEntry,
  bottomInset,
  refresh,
}: {
  entries: readonly LedgerEntry[];
  basis: UnitBasis;
  today: string;
  header: ReactElement;
  /** Shown under the header when there is nothing (loading, error, or "No payments yet"). */
  empty: ReactElement;
  onEndReached(): void;
  loadingMore: boolean;
  onPressEntry(e: LedgerEntry): void;
  /** Room under the last row for a pinned footer. */
  bottomInset: number;
  /** Pull to refresh. */
  refresh?: { refreshing: boolean; onRefresh(): void };
}) {
  const { t } = useTheme();
  const sections = useMemo(() => groupByDay(entries, today), [entries, today]);
  // A reversal names the payment it undoes; that row is usually on the same page.
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const renderItem: SectionListRenderItem<LedgerEntry, Section> = useCallback(
    ({ item, index, section }) => (
      <LedgerRow
        entry={item}
        reversed={item.reversesId ? byId.get(item.reversesId) : undefined}
        basis={basis}
        first={index === 0}
        last={index === section.data.length - 1}
        onPress={onPressEntry}
      />
    ),
    [basis, byId, onPressEntry],
  );

  return (
    <SectionList
      testID="ledger-list"
      sections={sections}
      keyExtractor={(e) => e.id}
      renderItem={renderItem}
      renderSectionHeader={({ section }) => (
        <Text variant="overline" accessibilityRole="header" style={styles.day}>
          {section.title}
        </Text>
      )}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={loadingMore ? <ActivityIndicator color={t.br} accessibilityLabel="Loading more" style={styles.more} /> : undefined}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        refresh ? (
          <RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColor={t.br} colors={[t.br]} />
        ) : undefined
      }
    />
  );
}

const LedgerRow = memo(function LedgerRow({
  entry,
  reversed,
  basis,
  first,
  last,
  onPress,
}: {
  entry: LedgerEntry;
  reversed: LedgerEntry | undefined;
  basis: UnitBasis;
  first: boolean;
  last: boolean;
  onPress(e: LedgerEntry): void;
}) {
  const { t } = useTheme();
  const title = ledgerTitle(entry, reversed);
  const caption = ledgerCaption(entry, basis);
  const amount = signedRupees(entry.amountRupees);
  const isPayment = entry.kind === 'payment';
  const wasReversed = entry.reversedById !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${amount}, ${caption}${wasReversed ? ', reversed' : ''}`}
      onPress={() => onPress(entry)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd },
        first ? styles.first : styles.middle,
        last ? styles.last : null,
      ]}
    >
      {isPayment ? (
        <View style={[styles.tile, { backgroundColor: t.dgs }]}>
          <Icon name="arrowUpRight" size={18} color={t.dgt} />
        </View>
      ) : null}
      <View style={styles.fill}>
        <Text weight="medium" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {caption}
        </Text>
      </View>
      <View style={styles.right}>
        <Text
          weight="semibold"
          numeric
          color={entry.amountRupees > 0 ? 'okt' : 'dgt'}
          style={wasReversed ? styles.struck : null}
        >
          {amount}
        </Text>
        {wasReversed ? <Badge kind="nu">Reversed</Badge> : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 4 },
  day: { paddingHorizontal: 4, paddingTop: 16, paddingBottom: 8 },
  more: { paddingVertical: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 56,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
  },
  first: { borderTopWidth: 1, borderTopLeftRadius: radius.group, borderTopRightRadius: radius.group },
  middle: {},
  last: { borderBottomLeftRadius: radius.group, borderBottomRightRadius: radius.group },
  tile: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
  right: { alignItems: 'flex-end', gap: 4 },
  struck: { textDecorationLine: 'line-through' },
});
