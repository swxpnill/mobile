import { type BrokerLedger, dueState, formatRupees, toDisplayQty, type UnitBasis } from '@tonnage/shared';
import { StyleSheet, View } from 'react-native';
import { monthName } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Text } from '../../ui';

type Summary = BrokerLedger['summary'];

/** The FIFO caption (Ruling 7). */
export function unpaidCaption(s: Summary, basis: UnitBasis): string {
  const state = dueState(s.dueRupees);
  if (state.kind === 'advance') return 'Paid ahead of earnings';
  if (state.kind === 'clear') return 'All paid';
  return `On ${toDisplayQty(s.unpaidKg, basis, { withUnit: true })} dispatched and not yet paid`;
}

/** Board 06's card: what is due (amber) or paid ahead (green), and this month's earned and paid. */
export function DueCard({ summary, basis }: { summary: Summary; basis: UnitBasis }) {
  const { t } = useTheme();
  const state = dueState(summary.dueRupees);
  const label = state.kind === 'advance' ? 'Advance' : 'Due to broker';
  const amount = formatRupees(state.rupees);
  const caption = unpaidCaption(summary, basis);
  const month = monthName(summary.month);
  return (
    <View testID="due-card" style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}>
      <View accessible accessibilityLabel={`${label} ${amount}. ${caption}`} style={styles.top}>
        <Text variant="overline">{label}</Text>
        <Text
          weight="semibold"
          numeric
          color={state.kind === 'due' ? 'wnt' : state.kind === 'advance' ? 'okt' : 'tx'}
          style={styles.amount}
          adjustsFontSizeToFit
          numberOfLines={1}
        >
          {amount}
        </Text>
        <Text variant="caption" style={styles.caption}>
          {caption}
        </Text>
      </View>
      <View style={[styles.split, { borderTopColor: t.bd }]}>
        <View style={styles.fill} accessible accessibilityLabel={`Earned in ${month} ${formatRupees(summary.earnedThisMonthRupees)}`}>
          <Text variant="caption">{`Earned in ${month}`}</Text>
          <Text weight="semibold" numeric color="okt" style={styles.small}>
            {formatRupees(summary.earnedThisMonthRupees)}
          </Text>
        </View>
        <View style={styles.fill} accessible accessibilityLabel={`Paid in ${month} ${formatRupees(summary.paidThisMonthRupees)}`}>
          <Text variant="caption">{`Paid in ${month}`}</Text>
          <Text weight="semibold" numeric color="brt" style={styles.small}>
            {formatRupees(summary.paidThisMonthRupees)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 20, gap: 14 },
  top: { gap: 8 },
  amount: { fontSize: 40, lineHeight: 44, letterSpacing: -1.2 },
  caption: { fontSize: 13, marginTop: -2 },
  split: { flexDirection: 'row', gap: 12, paddingTop: 14, borderTopWidth: 1 },
  fill: { flex: 1, minWidth: 0 },
  small: { marginTop: 2 },
});
