import { can, toDisplayQty } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { type DispatchState, useDispatchBoard } from '../../api/hooks/trucks';
import { useUnitFilter } from '../../prefs/unitFilter';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, Chip, Icon, Screen, SearchField, Text, UnitTag, useDebouncedValue } from '../../ui';
import { messageFor } from '../messages';
import { UnitSwitcherSheet } from '../UnitSwitcherSheet';
import { TruckCard } from './TruckCard';

const FILTERS: { value: DispatchState; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'loading', label: 'Loading' },
  { value: 'at_gate', label: 'At gate' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'dispatched_today', label: 'Dispatched today' },
];

/** Canvas board 08: trucks across the plants in scope; plant heads only read. */
export function DispatchScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { companyId } = useUnitFilter();
  const [state, setState] = useState<DispatchState>('open');
  const [search, setSearch] = useState('');
  const [switcher, setSwitcher] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
  const board = useDispatchBoard({ state, q });
  const all = useMemo(() => byCode(companies ?? []), [companies]);
  const slotOf = (code: string) => Math.max(0, all.findIndex((c) => c.code === code));
  const chosen = all.find((c) => c.id === companyId);
  const canEdit = me ? can(me.role, 'truck.edit') : false;
  const now = Date.now();

  const counts = board.data?.counts;
  const countOf = (s: DispatchState) =>
    counts === undefined ? undefined : s === 'open' ? counts.assigned + counts.at_gate + counts.loading : counts[s];
  const items = board.data?.items ?? [];
  const sentKg = state === 'dispatched_today' ? items.reduce((s, x) => s + (x.netKg ?? 0), 0) : null;

  const header = (
    <View style={styles.header}>
      <View style={styles.top}>
        <View style={styles.fill}>
          <Text variant="title" accessibilityRole="header">
            Dispatch
          </Text>
          <Text variant="caption" style={styles.sub}>
            {me?.role === 'plant_head' ? 'Today · your plants' : 'Today · live from all plants'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Switch unit — ${chosen ? chosen.name : 'All units'}`}
          onPress={() => setSwitcher(true)}
          style={({ pressed }) => [styles.pill, { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd }]}
        >
          {chosen ? <UnitTag code={chosen.code} slot={all.indexOf(chosen)} /> : null}
          <Text weight="medium" style={styles.small}>
            {chosen ? chosen.code : 'All units'}
          </Text>
          <Icon name="chevronDown" size={14} color={t.tx3} />
        </Pressable>
      </View>
      <SearchField value={search} onChangeText={setSearch} placeholder="Vehicle, order no, customer" label="Search trucks" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} count={countOf(f.value)} selected={state === f.value} onPress={() => setState(f.value)} />
        ))}
      </ScrollView>
      {sentKg !== null && items.length > 0 ? (
        <Text variant="caption">{`${toDisplayQty(sentKg, basis, { withUnit: true })} sent today`}</Text>
      ) : null}
    </View>
  );

  return (
    <Screen edges={['top']} scroll={false} contentStyle={styles.noPad}>
      <FlatList
        data={items}
        keyExtractor={(x) => x.id}
        renderItem={({ item }) => (
          <TruckCard
            truck={item}
            slot={slotOf(item.companyCode)}
            now={now}
            onOpen={() => router.push(`/trucks/${item.id}`)}
            onEdit={
              canEdit && item.state !== 'cancelled'
                ? () => router.push({ pathname: '/assign/[subOrderId]', params: { subOrderId: item.subOrderId, orderId: item.orderId, truckId: item.id } })
                : undefined
            }
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={
          board.isPending ? (
            <ActivityIndicator color={t.br} accessibilityLabel="Loading trucks" />
          ) : board.isError ? (
            <View style={styles.gap}>
              <Text color="tx2" accessibilityRole="alert">
                {messageFor(board.error)}
              </Text>
              <Button variant="secondary" onPress={() => void board.refetch()}>
                Try again
              </Button>
            </View>
          ) : (
            <Text color="tx2" style={styles.empty}>
              {q ? `No trucks match “${q}”` : 'No trucks here right now'}
            </Text>
          )
        }
        refreshControl={
          <RefreshControl refreshing={board.isRefetching} onRefresh={() => void board.refetch()} tintColor={t.br} colors={[t.br]} />
        }
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        windowSize={7}
      />
      <UnitSwitcherSheet visible={switcher} onClose={() => setSwitcher(false)} />
    </Screen>
  );
}

const Separator = () => <View style={styles.sep} />;

const styles = StyleSheet.create({
  noPad: { padding: 0, paddingHorizontal: 0, paddingTop: 0, gap: 0 },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
  header: { gap: 14, marginBottom: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  sub: { fontSize: 13 },
  small: { fontSize: 13 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1 },
  chips: { gap: 8 },
  gap: { gap: 12 },
  empty: { textAlign: 'center', paddingVertical: 24 },
  sep: { height: 10 },
});
