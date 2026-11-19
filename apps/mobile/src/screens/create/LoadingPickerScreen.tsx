import { type Order, type OrderSummary, type SubOrder, toDisplayQty } from '@tonnage/shared';
import { useQueries } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useSignedIn } from '../../api/hooks/cache';
import { useDisplayBasis } from '../../api/hooks/me';
import { orderQuery, useOrders } from '../../api/hooks/orders';
import { useUnitFilter } from '../../prefs/unitFilter';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, EmptyState, Group, Header, Icon, Row, Screen, SearchField, Text, UnitTag, useDebouncedValue } from '../../ui';
import { UnitSwitcherSheet } from '../UnitSwitcherSheet';
import { assignHref } from '../orders/OrderTrucks';

const LOADABLE = new Set<SubOrder['status']>(['open', 'partly_dispatched']);

export interface LoadableRow {
  order: Order;
  sub: SubOrder;
}

/** Sub-orders a truck can be loaded against: open or partly dispatched, in the chosen unit. */
export function loadableRows(orders: readonly Order[], companyId: string): LoadableRow[] {
  return orders.flatMap((order) =>
    order.subOrders
      .filter((sub) => LOADABLE.has(sub.status) && (companyId === 'all' || sub.companyId === companyId))
      .map((sub) => ({ order, sub })),
  );
}

const partyOf = (o: Order) => o.customer?.name ?? o.broker?.name ?? 'Customer not added yet';

/**
 * "Create new → Loading": pick an open or partly dispatched sub-order, then assign a vehicle to
 * it. Uses the orders list (open + partly dispatched, unit switcher, search) and each order's
 * detail for its sub-orders; no route of its own.
 */
export function LoadingPickerScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const signedIn = useSignedIn();
  const { companyId } = useUnitFilter();
  const { data: companies } = useCompanies();
  const [search, setSearch] = useState('');
  const [switcher, setSwitcher] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);

  const open = useOrders({ status: 'open', q });
  const partly = useOrders({ status: 'partly_dispatched', q });
  const summaries = useMemo(() => {
    const all = [...(open.data?.pages ?? []), ...(partly.data?.pages ?? [])].flatMap((p) => p.items);
    const seen = new Set<string>();
    return all
      .filter((o: OrderSummary) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [open.data, partly.data]);
  const details = useQueries({
    queries: summaries.map((s) => ({ ...orderQuery(s.id), enabled: signedIn })),
  });
  const orders = details.flatMap((d) => (d.data ? [d.data] : []));
  const rows = loadableRows(orders, companyId);

  const all = useMemo(() => byCode(companies ?? []), [companies]);
  const slotOf = (code: string) => Math.max(0, all.findIndex((c) => c.code === code));
  const chosen = all.find((c) => c.id === companyId);
  const loading = open.isPending || partly.isPending || details.some((d) => d.isPending);
  const more = open.hasNextPage || partly.hasNextPage;

  return (
    <Screen
      title="Loading"
      header={
        <Header
          onBack={() => router.back()}
          right={
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
          }
        />
      }
    >
      <Text variant="caption">Choose the open order to load a truck against.</Text>
      <SearchField value={search} onChangeText={setSearch} placeholder="Search order no., party" />
      {rows.length === 0 && loading ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="truck"
          title={q ? 'No open orders match' : 'No open orders'}
          body={q ? `Nothing open matches “${q}”.` : 'Trucks are loaded against an open order. Book one first.'}
          actions={[{ label: 'Create order', onPress: () => router.push('/order-form') }]}
        />
      ) : (
        <Group>
          {rows.map(({ order, sub }) => {
            const party = partyOf(order);
            const pending = toDisplayQty(sub.totals.pendingKg, basis, { withUnit: true });
            return (
              <Row
                key={sub.id}
                onPress={() => router.push(assignHref(order, sub))}
                accessibilityLabel={`${sub.number}, unit ${sub.companyCode}, ${party}, ${pending} pending`}
              >
                <View style={styles.fill}>
                  <View style={styles.line}>
                    <Text weight="medium" numberOfLines={1}>
                      {sub.number}
                    </Text>
                    <UnitTag code={sub.companyCode} slot={slotOf(sub.companyCode)} />
                  </View>
                  <Text variant="caption" numberOfLines={1}>
                    {party}
                  </Text>
                </View>
                <View style={styles.right}>
                  <Text numeric weight="medium">
                    {pending}
                  </Text>
                  <Text variant="caption">pending</Text>
                </View>
                <Icon name="chevronRight" size={18} color={t.tx3} />
              </Row>
            );
          })}
        </Group>
      )}
      {more ? (
        <Button
          variant="secondary"
          onPress={() => {
            if (open.hasNextPage) void open.fetchNextPage();
            if (partly.hasNextPage) void partly.fetchNextPage();
          }}
        >
          Show more
        </Button>
      ) : null}
      <UnitSwitcherSheet visible={switcher} onClose={() => setSwitcher(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  right: { alignItems: 'flex-end' },
  small: { fontSize: 13 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, marginRight: 12 },
});
