import { type OrderSummary, formatRupeesShort, toDisplayQty, unitLabel } from '@tonnage/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { relativeTime } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, MoneyText, ProgressBar, Text, UnitTag } from '../../ui';
import { statusMeta } from './statusMeta';

/** Canvas board 03 order card. `slotOf` gives each company code its tag colour slot. */
export const OrderCard = memo(function OrderCard({
  o,
  now,
  slotOf,
  onPress,
}: {
  o: OrderSummary;
  now: number;
  slotOf(code: string): number;
  onPress(): void;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const meta = statusMeta(o.status);
  const qty = (kg: number) => toDisplayQty(kg, basis);
  const unit = unitLabel(basis);
  const title = o.customerName ? `${o.customerName}${o.customerCity ? `, ${o.customerCity}` : ''}` : 'Customer not added yet';
  const via = o.type === 'broker_only' ? `Broker order · ${o.brokerName ?? ''}` : o.brokerName ? `via ${o.brokerName}` : 'Direct';
  const sub = [via, o.productsLabel, relativeTime(o.createdAt, now)].filter(Boolean).join(' · ');
  const { orderedKg, dispatchedKg, closedKg, overKg } = o.totals;
  const extra = closedKg > 0 ? ` · ${qty(closedKg)} closed` : overKg > 0 ? ` · +${qty(overKg)} over` : '';
  const tone = o.status === 'completed' ? 'ok' : o.status === 'short_closed' || o.status === 'cancelled' ? 'muted' : 'bar';
  const label = [
    o.number,
    meta.label,
    title,
    sub.replace(/^Broker order/, 'broker order'),
    `${qty(dispatchedKg)} of ${qty(orderedKg)} ${unit} dispatched${extra}`,
    o.isAged ? `older than ${o.ageDays} days` : null,
    o.estimatedValue !== undefined ? formatRupeesShort(o.estimatedValue) : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd }]}
    >
      <View style={styles.top}>
        <Text weight="medium" style={styles.number}>
          {o.number}
        </Text>
        {o.companyCodes.map((c) => (
          <UnitTag key={c} code={c} slot={slotOf(c)} />
        ))}
        <View style={styles.fill} />
        {o.isAged ? <Badge kind="dg">{`${o.ageDays} d`}</Badge> : null}
        <Badge kind={meta.kind} dot>
          {meta.label}
        </Badge>
      </View>
      <View>
        <Text weight="semibold" numberOfLines={1} color={o.customerName ? 'tx' : 'wnt'} style={styles.title}>
          {title}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <ProgressBar value={orderedKg > 0 ? dispatchedKg / orderedKg : 0} tone={tone} />
      <View style={styles.bottom}>
        <Text variant="caption" style={styles.fill} numberOfLines={1}>
          <Text weight="medium" variant="caption" color="tx">
            {qty(dispatchedKg)}
          </Text>
          <Text variant="caption">{` / ${qty(orderedKg)} ${unit}`}</Text>
          {closedKg > 0 ? <Text variant="caption">{` · ${qty(closedKg)} closed`}</Text> : null}
          {closedKg === 0 && overKg > 0 ? <Text variant="caption" color="wnt">{` · +${qty(overKg)} over`}</Text> : null}
        </Text>
        <MoneyText rupees={o.estimatedValue} short variant="caption" weight="medium" color="tx2" />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  number: { fontSize: 13 },
  title: { fontSize: 15 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
});
