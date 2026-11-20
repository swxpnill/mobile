import { type Order, type SubOrder, toDisplayQty, unitLabel } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, Button, Group, Icon, Row, Text } from '../../ui';
import { TRUCK_STATE_META } from '../dispatch/truckStateMeta';
import { truckLine } from './ShortCloseSheet';

/** Where "Assign vehicle" goes for one sub-order. */
export const assignHref = (o: Order, s: SubOrder) =>
  ({ pathname: '/assign/[subOrderId]', params: { subOrderId: s.id, orderId: o.id } }) as const;

/** "1 awaiting approval · 1 loading · 1 at gate · 1 assigned" for a sub-order's open trucks; null when it has none. */
export function truckSummary(s: SubOrder): string | null {
  const n = (state: 'weighed' | 'loading' | 'at_gate' | 'assigned') => s.openTrucks.filter((x) => x.state === state).length;
  const parts = (['weighed', 'loading', 'at_gate', 'assigned'] as const)
    .filter((st) => n(st) > 0)
    .map((st) => `${n(st)} ${TRUCK_STATE_META[st].label.toLowerCase()}`);
  if (s.dispatchedTrucks > 0) parts.push(`${s.dispatchedTrucks} dispatched`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Under a sub-order: its trucks in a line, and "Assign vehicle" for those who may. */
export function SubOrderTrucks({ o, s, canAssign }: { o: Order; s: SubOrder; canAssign: boolean }) {
  const router = useRouter();
  const summary = truckSummary(s);
  if (!summary && !canAssign) return null;
  return (
    <View style={styles.inline}>
      <Text variant="caption" style={styles.fill}>
        {summary ? `Trucks · ${summary}` : 'No trucks yet'}
      </Text>
      {canAssign ? (
        <Button variant="secondary" onPress={() => router.push(assignHref(o, s))} style={styles.small}>
          Assign vehicle
        </Button>
      ) : null}
    </View>
  );
}

/** The order's open trucks, each opening its detail, and the dispatched count. */
export function OrderTrucks({ o }: { o: Order }) {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const dispatched = o.subOrders.reduce((n, s) => n + s.dispatchedTrucks, 0);
  const open = o.subOrders.flatMap((s) => s.openTrucks);
  if (open.length === 0 && dispatched === 0) return null;
  return (
    <>
      <Text variant="heading">Trucks</Text>
      <Group>
        {o.subOrders.flatMap((s) =>
          s.openTrucks.map((x) => {
            const meta = TRUCK_STATE_META[x.state];
            return (
              <Row key={x.id} onPress={() => router.push(`/trucks/${x.id}`)} accessibilityLabel={truckLine(x, basis).replace(' — ', ', ')}>
                <View style={styles.fill}>
                  <Text weight="medium">{x.vehicleNo}</Text>
                  <Text variant="caption">{`${s.companyCode} · sub-order ${s.suffix}${x.tareKg !== null ? ` · tare ${toDisplayQty(x.tareKg, basis, { withUnit: true })}` : ''}`}</Text>
                </View>
                <Badge kind={meta.kind} dot>
                  {meta.label}
                </Badge>
                <Icon name="chevronRight" size={18} color={t.tx3} />
              </Row>
            );
          }),
        )}
        {dispatched > 0 ? (
          <Row>
            <Text color="tx2" style={styles.fill}>{`${dispatched} ${dispatched === 1 ? 'truck' : 'trucks'} dispatched · ${toDisplayQty(o.totals.dispatchedKg, basis)} ${unitLabel(basis)} net`}</Text>
          </Row>
        ) : null}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fill: { flex: 1, minWidth: 0 },
  small: { height: 44, paddingHorizontal: 14 },
});
