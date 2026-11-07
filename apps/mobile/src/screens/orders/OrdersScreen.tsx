import { type OrderListStatus, can, toDisplayQty, unitLabel } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useDrafts, useHome, useOrders } from '../../api/hooks/orders';
import { useTheme } from '../../theme/ThemeProvider';
import { unitTagColors } from '../../theme/tokens';
import { Button, Chip, Group, Icon, Row, Screen, SearchField, Text, useDebouncedValue } from '../../ui';
import { messageFor } from '../messages';
import { FirstRun } from './FirstRun';
import { OrderCard } from './OrderCard';
import { STATUS_META } from './statusMeta';

const CHIPS: OrderListStatus[] = ['all', 'open', 'partly_dispatched', 'completed', 'short_closed', 'cancelled'];

/** Canvas board 03: every order the person may see, filtered by the unit switcher. */
export function OrdersScreen({ initialAged = false }: { initialAged?: boolean }) {
  const router = useRouter();
  const { t, scheme } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const [status, setStatus] = useState<OrderListStatus>('all');
  const [aged, setAged] = useState(initialAged);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const list = useOrders({ status, q, sort, aged: aged || undefined });
  const home = useHome();
  const canCreate = me ? can(me.role, 'order.create') : false;
  const drafts = useDrafts(canCreate);
  const all = useMemo(() => byCode(companies ?? []), [companies]);
  const slotOf = useCallback((code: string) => Math.max(0, all.findIndex((c) => c.code === code)), [all]);
  const now = Date.now();
  const unit = unitLabel(basis);

  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const counts = pages[0]?.counts;
  const filtered = status !== 'all' || aged || q !== '';
  const firstRun = counts !== undefined && counts.all === 0 && !filtered;
  const myDrafts = canCreate ? (drafts.data ?? []) : [];
  const h = home.data;

  const header = (
    <View style={styles.header}>
      <Text variant="title" accessibilityRole="header">
        Orders
      </Text>
      {firstRun ? null : (
        <>
          <SearchField value={search} onChangeText={setSearch} placeholder="Order no, party, broker, vehicle" label="Search orders" />
          {h ? (
            <Group>
              <View style={styles.summary}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Pending to dispatch, ${toDisplayQty(h.pendingKg, basis)} ${unit} — show open orders`}
                  onPress={() => {
                    setAged(false);
                    setStatus('open');
                  }}
                  style={styles.summaryMain}
                >
                  <Text variant="caption">Pending to dispatch</Text>
                  <View style={styles.baseline}>
                    <Text numeric weight="semibold" color="wnt" style={styles.big}>
                      {toDisplayQty(h.pendingKg, basis)}
                    </Text>
                    <Text variant="caption" weight="medium">
                      {unit}
                    </Text>
                  </View>
                  {h.perCompany.length > 1 && h.pendingKg > 0 ? (
                    <View style={styles.stack}>
                      {h.perCompany
                        .filter((c) => c.pendingKg > 0)
                        .map((c) => (
                          <View key={c.companyId} style={{ flex: c.pendingKg, backgroundColor: unitTagColors(slotOf(c.code), scheme).fg, borderRadius: 1 }} />
                        ))}
                    </View>
                  ) : null}
                  <Text variant="caption">{`${h.openOrders} open orders · ${h.unitCount} ${h.unitCount === 1 ? 'unit' : 'units'}`}</Text>
                </Pressable>
                <View style={[styles.divider, { backgroundColor: t.bd }]} />
                <View style={styles.summarySide}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${h.agedOrders} orders older than ${h.agedOrderDays} days — ${aged ? 'show all' : 'show them'}`}
                    accessibilityState={{ selected: aged }}
                    onPress={() => setAged((x) => !x)}
                  >
                    <Text variant="caption">{`Older than ${h.agedOrderDays} days`}</Text>
                    <Text weight="semibold" color={h.agedOrders > 0 ? 'dgt' : 'tx'} style={styles.mid}>
                      {String(h.agedOrders)} <Text variant="caption">orders</Text>
                    </Text>
                  </Pressable>
                  <View accessible accessibilityLabel={`Sent this week, ${toDisplayQty(h.sentThisWeek.kg, basis)} ${unit}`}>
                    <Text variant="caption">Sent this week</Text>
                    <Text weight="semibold" color="okt" style={styles.mid}>
                      {toDisplayQty(h.sentThisWeek.kg, basis)}{' '}
                      <Text variant="caption">
                        {h.sentThisWeek.changePct === null ? unit : `${unit} · ${h.sentThisWeek.changePct >= 0 ? '+' : ''}${h.sentThisWeek.changePct}%`}
                      </Text>
                    </Text>
                  </View>
                </View>
              </View>
            </Group>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {CHIPS.filter((s) => s !== 'cancelled' || (counts?.cancelled ?? 0) > 0).map((s) => (
              <Chip
                key={s}
                label={s === 'all' ? 'All' : STATUS_META[s].short}
                count={counts?.[s]}
                selected={status === s}
                onPress={() => setStatus(s)}
              />
            ))}
          </ScrollView>
          <View style={styles.countRow}>
            <Text variant="caption" style={styles.fill}>
              <Text weight="medium" variant="caption" color="tx">
                {String(status === 'all' ? (counts?.all ?? 0) : (counts?.[status] ?? 0))}
              </Text>
              {` orders${aged ? ` · older than ${h?.agedOrderDays ?? 10} days` : ''}`}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sort: ${sort === 'newest' ? 'newest first' : 'oldest first'}`}
              onPress={() => setSort((x) => (x === 'newest' ? 'oldest' : 'newest'))}
              style={styles.sort}
              hitSlop={8}
            >
              <Text weight="medium" variant="caption" color="tx2">
                {sort === 'newest' ? 'Newest first' : 'Oldest first'}
              </Text>
              <Icon name="chevronDown" size={14} color={t.tx2} />
            </Pressable>
          </View>
          {myDrafts.length > 0 ? (
            <Group>
              <Row onPress={() => router.push({ pathname: '/order-form', params: { draftId: myDrafts[0]!.id } })} accessibilityLabel={`Drafts, ${myDrafts.length} — continue the latest`}>
                <Icon name="pencil" size={18} color={t.brt} />
                <Text weight="medium" style={styles.fill}>{`Drafts · ${myDrafts.length}`}</Text>
                <Text variant="caption">Continue the latest</Text>
                <Icon name="chevronRight" size={18} color={t.tx3} />
              </Row>
            </Group>
          ) : null}
        </>
      )}
    </View>
  );

  return (
    <Screen edges={['top']} scroll={false} contentStyle={styles.noPad}>
      <FlatList
        data={firstRun ? [] : items}
        keyExtractor={(o) => o.id}
        renderItem={({ item }) => <OrderCard o={item} now={now} slotOf={slotOf} onPress={() => router.push(`/orders/${item.id}`)} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          list.isPending ? (
            <ActivityIndicator color={t.br} accessibilityLabel="Loading orders" />
          ) : list.isError ? (
            <View style={styles.gap}>
              <Text color="tx2" accessibilityRole="alert">
                {messageFor(list.error)}
              </Text>
              <Button variant="secondary" onPress={() => void list.refetch()}>
                Try again
              </Button>
            </View>
          ) : firstRun ? (
            <FirstRun canCreate={canCreate} />
          ) : (
            <Text color="tx2" style={styles.empty}>
              {q ? `No orders match “${q}”` : 'No orders here'}
            </Text>
          )
        }
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator color={t.br} accessibilityLabel="Loading more" /> : undefined}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching && !list.isFetchingNextPage}
            onRefresh={() => {
              void list.refetch();
              void home.refetch();
            }}
            tintColor={t.br}
            colors={[t.br]}
          />
        }
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        windowSize={7}
      />
    </Screen>
  );
}

const Separator = () => <View style={{ height: 10 }} />;

const styles = StyleSheet.create({
  noPad: { padding: 0, paddingHorizontal: 0, paddingTop: 0, gap: 0 },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
  header: { gap: 16, marginBottom: 12 },
  summary: { flexDirection: 'row', padding: 16, gap: 16 },
  summaryMain: { flex: 1.35, minWidth: 0, gap: 4 },
  summarySide: { flex: 1, justifyContent: 'space-between', gap: 12 },
  divider: { width: StyleSheet.hairlineWidth },
  baseline: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  big: { fontSize: 28, lineHeight: 32 },
  mid: { fontSize: 18, lineHeight: 24 },
  stack: { flexDirection: 'row', gap: 2, height: 6, marginTop: 8 },
  chips: { gap: 8 },
  countRow: { flexDirection: 'row', alignItems: 'center', marginTop: -6 },
  sort: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  fill: { flex: 1, minWidth: 0 },
  gap: { gap: 12 },
  empty: { textAlign: 'center', paddingVertical: 24 },
});
