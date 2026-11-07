import { formatRupeesShort, toDisplayQty, unitLabel } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useHome } from '../../api/hooks/orders';
import { istGreeting, istLongDate } from '../../format/time';
import { useUnitFilter } from '../../prefs/unitFilter';
import { useTheme } from '../../theme/ThemeProvider';
import { unitTagColors } from '../../theme/tokens';
import { Avatar, Badge, Button, Group, Icon, Screen, Text, UnitTag } from '../../ui';
import { messageFor } from '../messages';
import { UnitSwitcherSheet } from '../UnitSwitcherSheet';

const short = (name: string) => name.split(/\s+/)[0] ?? name;

/** Canvas board 02 (owner, city staff, plant head). "In plant now" arrives with trucks in F3. */
export function HomeScreen() {
  const router = useRouter();
  const { t, scheme } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { companyId } = useUnitFilter();
  const home = useHome();
  const [switcher, setSwitcher] = useState(false);
  const now = Date.now();
  const all = byCode(companies ?? []);
  const chosen = all.find((c) => c.id === companyId);
  const unit = unitLabel(basis);
  const qty = (kg: number) => toDisplayQty(kg, basis);
  const h = home.data;

  return (
    <Screen edges={['top']} refresh={{ refreshing: home.isRefetching, onRefresh: () => void home.refetch() }}>
      <View style={styles.top}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Switch unit — ${chosen ? chosen.name : 'All units'}`}
          onPress={() => setSwitcher(true)}
          style={({ pressed }) => [styles.pill, { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd }]}
        >
          {chosen ? (
            <UnitTag code={chosen.code} slot={all.indexOf(chosen)} />
          ) : (
            <View style={[styles.pillIcon, { backgroundColor: t.brs }]}>
              <Icon name="factory" size={16} color={t.brt} />
            </View>
          )}
          <Text weight="medium">{chosen ? short(chosen.name) : 'All units'}</Text>
          <Icon name="chevronDown" size={16} color={t.tx3} />
        </Pressable>
        <View style={styles.fill} />
        {me ? <Avatar name={me.name} tone="br" /> : null}
      </View>

      <View>
        <Text variant="caption" style={styles.date}>
          {istLongDate(now)}
        </Text>
        <Text variant="title" accessibilityRole="header">
          {me ? `${istGreeting(now)}, ${short(me.name)}` : istGreeting(now)}
        </Text>
      </View>

      {!h ? (
        home.isError ? (
          <View style={styles.gap}>
            <Text color="tx2" accessibilityRole="alert">
              {messageFor(home.error)}
            </Text>
            <Button variant="secondary" onPress={() => void home.refetch()}>
              Try again
            </Button>
          </View>
        ) : (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        )
      ) : (
        <>
          <Group>
            <View style={styles.card} accessibilityLabel={`Pending dispatch, ${qty(h.pendingKg)} ${unit}`}>
              <View style={styles.row}>
                <Text variant="overline" style={styles.fill}>
                  Pending dispatch
                </Text>
                {h.agedOrders > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${h.agedOrders} orders older than ${h.agedOrderDays} days — show them`}
                    onPress={() => router.push({ pathname: '/orders', params: { aged: '1' } })}
                    hitSlop={10}
                  >
                    <Badge kind="wn" dot>{`${h.agedOrders} older than ${h.agedOrderDays} days`}</Badge>
                  </Pressable>
                ) : null}
              </View>
              <View>
                <View style={styles.baseline}>
                  <Text numeric weight="semibold" style={styles.big}>
                    {qty(h.pendingKg)}
                  </Text>
                  <Text weight="medium" color="tx2">
                    {unit}
                  </Text>
                </View>
                <Text variant="caption">{`${h.openOrders} open ${h.openOrders === 1 ? 'order' : 'orders'} across ${h.unitCount} ${h.unitCount === 1 ? 'unit' : 'units'}`}</Text>
              </View>
              {h.perCompany.length > 1 && h.pendingKg > 0 ? (
                <>
                  <View style={styles.stack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {h.perCompany
                      .filter((c) => c.pendingKg > 0)
                      .map((c) => (
                        <View
                          key={c.companyId}
                          style={{ flex: c.pendingKg, backgroundColor: unitTagColors(all.findIndex((x) => x.id === c.companyId), scheme).fg, borderRadius: 2 }}
                        />
                      ))}
                  </View>
                  <View style={styles.legend}>
                    {h.perCompany.map((c) => {
                      const co = all.find((x) => x.id === c.companyId);
                      const label = `${short(co?.name ?? c.name)} · ${c.code}`;
                      return (
                        <View key={c.companyId} style={styles.legendItem} accessible accessibilityLabel={`${label}, ${qty(c.pendingKg)} ${unit} pending`}>
                          <View style={[styles.swatch, { backgroundColor: unitTagColors(all.findIndex((x) => x.id === c.companyId), scheme).fg }]} />
                          <Text variant="caption" style={styles.fill} numberOfLines={1}>
                            {label}
                          </Text>
                          <Text weight="medium" variant="caption" color="tx" numeric>
                            {qty(c.pendingKg)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </>
              ) : null}
            </View>
          </Group>

          <View style={styles.tiles}>
            <Tile
              label="Booked today"
              value={qty(h.bookedToday.kg)}
              unit={unit}
              detail={`${h.bookedToday.orders} ${h.bookedToday.orders === 1 ? 'order' : 'orders'}`}
              money={h.bookedToday.valueRupees}
            />
            <Tile
              label="Dispatched today"
              value={qty(h.dispatchedToday.kg)}
              unit={unit}
              detail={`${h.dispatchedToday.trucks} ${h.dispatchedToday.trucks === 1 ? 'truck' : 'trucks'}`}
            />
          </View>
        </>
      )}
      <UnitSwitcherSheet visible={switcher} onClose={() => setSwitcher(false)} />
    </Screen>
  );
}

function Tile({ label, value, unit, detail, money }: { label: string; value: string; unit: string; detail: string; money?: number }) {
  const shortMoney = money !== undefined ? formatRupeesShort(money) : undefined;
  return (
    <View style={styles.tileWrap}>
      <Group>
        <View style={styles.tile} accessible accessibilityLabel={[label, `${value} ${unit}`, detail, shortMoney].filter(Boolean).join(', ')}>
          <Text variant="caption">{label}</Text>
          <Text numeric weight="semibold" style={styles.mid}>
            {value} <Text variant="caption">{unit}</Text>
          </Text>
          <Text variant="caption">
            {detail}
            {shortMoney ? (
              <Text variant="caption" color="brt">
                {` · ${shortMoney}`}
              </Text>
            ) : null}
          </Text>
        </View>
      </Group>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingLeft: 6, paddingRight: 14, borderRadius: 22, borderWidth: 1 },
  pillIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
  date: { fontSize: 13 },
  gap: { gap: 12 },
  card: { padding: 20, gap: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  baseline: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  big: { fontSize: 40, lineHeight: 44, letterSpacing: -1.2 },
  stack: { flexDirection: 'row', gap: 3, height: 8 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10, columnGap: 20 },
  legendItem: { width: '45%', flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  tiles: { flexDirection: 'row', gap: 12 },
  tileWrap: { flex: 1 },
  tile: { padding: 16, gap: 4 },
  mid: { fontSize: 22, lineHeight: 28 },
});
