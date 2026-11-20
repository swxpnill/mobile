import { type DispatchBoard, toDisplayQty } from '@tonnage/shared';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { relativeTime } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, type Tokens } from '../../theme/tokens';
import { Badge, Button, Icon, showToast, Text, UnitTag } from '../../ui';
import { TRUCK_STATE_META, TRUCK_STEPS, planLabel, shownPhone } from './truckStateMeta';

type BoardTruck = DispatchBoard['items'][number];

/** One truck on the Dispatch board (canvas 08): state, steps, customer and plan, driver. */
export function TruckCard({
  truck: x,
  slot,
  now,
  onOpen,
  onEdit,
  onApprove,
}: {
  truck: BoardTruck;
  slot: number;
  now: number;
  onOpen(): void;
  /** Absent for read-only roles (plant head). */
  onEdit?: () => void;
  /** TON-57: on a truck awaiting approval, for the roles that approve. */
  onApprove?: () => void;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const meta = TRUCK_STATE_META[x.state];
  const planned = x.plan.reduce((s, p) => s + p.plannedKg, 0);
  const weighed = x.state === 'weighed' || x.state === 'dispatched';
  const since = x.state === 'dispatched' ? x.dispatchedAt : x.state === 'weighed' ? x.weighedAt : (x.tareAt ?? x.atGateAt ?? x.assignedAt);
  const what =
    weighed && x.netKg !== null
      ? `net ${toDisplayQty(x.netKg, basis, { withUnit: true })}`
      : `plan ${toDisplayQty(planned, basis, { withUnit: true })}${x.tareKg !== null ? ` · tare ${toDisplayQty(x.tareKg, basis)}` : ''}`;
  const ago = since && x.state !== 'cancelled' ? relativeTime(since, now) : null;
  const lines = x.plan.map(planLabel).join(', ');
  const done = meta.step;
  const stepColor: (keyof Tokens)[] = ['vi', 'br', 'wn', 'ok'];
  const approvable = x.state === 'weighed' && onApprove !== undefined;
  const call = async () => {
    try {
      await Linking.openURL(`tel:${x.driverPhone}`);
    } catch {
      showToast("Couldn't start a call on this phone");
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${x.vehicleNo}, ${meta.label}${ago ? ` ${ago}` : ''}, ${x.customerName ?? 'no customer'}, ${x.subOrderNumber}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.main, pressed ? { opacity: 0.85 } : null]}
      >
        <View style={styles.inline}>
          <Text weight="semibold" style={[styles.fill, styles.vehicle]}>
            {x.vehicleNo}
          </Text>
          <UnitTag code={x.companyCode} slot={slot} />
          <Badge kind={meta.kind} dot>
            {meta.label}
          </Badge>
        </View>
        {ago ? <Text variant="caption">{`${meta.label} · ${ago}`}</Text> : null}
        <View style={styles.steps} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {TRUCK_STEPS.map((s, i) => (
            <View key={s} style={[styles.step, { backgroundColor: i < done ? t[stepColor[i]!] : t.act }]} />
          ))}
        </View>
        <View>
          <Text weight="medium" numberOfLines={1}>
            {x.customerName ?? 'Customer not added yet'}
          </Text>
          <Text variant="caption" numberOfLines={1}>{`${x.subOrderNumber} · ${lines} · ${what}`}</Text>
        </View>
      </Pressable>
      {approvable ? (
        <Button onPress={onApprove} accessibilityLabel={`Approve dispatch, ${x.vehicleNo}`}>
          Approve dispatch
        </Button>
      ) : null}
      <View style={[styles.foot, { borderTopColor: t.bd }]}>
        <View style={styles.fill}>
          <Text variant="caption" numberOfLines={1}>
            {`${x.transporter?.name ?? 'Self'} · ${x.lrNo ? `LR ${x.lrNo}` : 'LR not added'}`}
          </Text>
          <Text weight="medium" style={styles.small} numberOfLines={1}>{`${x.driverName} · ${shownPhone(x.driverPhone)}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Call driver ${x.driverName}`}
          onPress={() => void call()}
          hitSlop={4}
          style={[styles.icon, { backgroundColor: t.brs }]}
        >
          <Icon name="phone" size={16} color={t.brt} />
        </Pressable>
        {onEdit ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Edit vehicle details, ${x.vehicleNo}`}
            onPress={onEdit}
            hitSlop={4}
            style={[styles.icon, { backgroundColor: t.ctl }]}
          >
            <Icon name="pencil" size={16} color={t.tx2} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  main: { gap: 10 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  vehicle: { fontSize: 16, lineHeight: 22 },
  steps: { flexDirection: 'row', gap: 4 },
  step: { flex: 1, height: 4, borderRadius: 2 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: 1 },
  small: { fontSize: 13, lineHeight: 18 },
  icon: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
