import { toDisplayQty, unitLabel } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { istClock } from '../../format/time';
import { type DispatchedView, dispatchedView, useDeviceSnapshot } from '../../offline/useDeviceData';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, Button, EmptyState, Icon, Screen, Text } from '../../ui';
import { usePlantTitle } from './usePlantTitle';

/**
 * Canvas 13 after saving the weights: the net, and (TON-57) "Awaiting approval" until the office
 * approves the dispatch, then the loading slip ("Waiting for network" before the server has it). The order progress bar, WhatsApp updates and
 * "Share loading slip" are left out: a supervisor's data has no order totals, and notifications
 * come in F4/F5.
 */
export function DispatchedScreen({ truckId }: { truckId: string }) {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const place = usePlantTitle();
  const snap = useDeviceSnapshot();
  const found = snap ? dispatchedView(snap, truckId) : null;
  // Between the server accepting the gross and the next done-today read, the truck is briefly in
  // neither list: keep showing what was last known.
  const last = useRef<DispatchedView | null>(null);
  if (found) last.current = found;
  const view = last.current;
  const toTasks = () => router.navigate('/tasks');

  if (!view) {
    return (
      <Screen>
        {snap === null ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="truck"
            title="Not on this phone"
            body="This truck's weight is not on this phone."
            actions={[{ label: 'Back to my tasks', onPress: toTasks }]}
          />
        )}
      </Screen>
    );
  }

  const where = place ? ` ${view.approved ? 'left' : 'weighed at'} ${place}` : view.approved ? ' left' : ' weighed';
  const left = `${view.vehicleNo}${where} at ${istClock(view.at)}`;
  const slipState = view.slipNo ?? (view.sync === 'rejected' ? 'needs the owner' : view.sync === 'waiting' ? 'waiting for network' : 'awaiting approval');

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.top}>
        <View style={[styles.check, { backgroundColor: view.approved ? t.oks : t.wns }]}>
          <Icon name={view.approved ? 'check' : 'clock'} size={36} color={view.approved ? t.okt : t.wnt} strokeWidth={2} />
        </View>
        <Text variant="title" accessibilityRole="header">
          {view.approved ? 'Dispatched' : 'Weights saved'}
        </Text>
        <Text color="tx2" style={styles.lead}>
          {left}
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}>
        <View
          style={styles.net}
          accessible
          accessibilityLabel={`Net weight ${toDisplayQty(view.netKg, basis, { withUnit: true })}`}
        >
          <Text variant="caption" style={styles.fill}>
            Net weight
          </Text>
          <Text numeric weight="semibold" color="okt" style={styles.netValue}>
            {toDisplayQty(view.netKg, basis)}
          </Text>
          <Text weight="medium" color="tx2">
            {unitLabel(basis)}
          </Text>
        </View>
        <View style={[styles.section, { borderTopColor: t.bd }]}>
          <Text weight="medium" style={styles.fill}>
            {view.subOrderNumber}
          </Text>
          {view.customerName ? <Text variant="caption">{view.customerName}</Text> : null}
        </View>
        <View
          style={[styles.section, { borderTopColor: t.bd }]}
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Loading slip, ${slipState}`}
        >
          <Text color="tx2" style={styles.fill}>
            Loading slip
          </Text>
          {view.slipNo ? (
            <Text weight="semibold" color="brt">
              {view.slipNo}
            </Text>
          ) : view.sync === 'rejected' ? (
            <Badge kind="dg" dot>
              Needs the owner
            </Badge>
          ) : view.sync === 'waiting' ? (
            <Badge kind="wn" dot>
              Waiting for network
            </Badge>
          ) : (
            <Badge kind="vi" dot>
              Awaiting approval
            </Badge>
          )}
        </View>
      </View>

      {view.sync === 'waiting' ? (
        <Text variant="caption" style={styles.centered}>
          Saved on this phone · it syncs automatically
        </Text>
      ) : null}

      <View style={styles.fill} />
      <Button onPress={toTasks}>Back to my tasks</Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  content: { paddingTop: 56, paddingBottom: 24, gap: 20 },
  top: { alignItems: 'center', gap: 12 },
  check: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  lead: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  card: { padding: 20, gap: 14, borderRadius: 16, borderWidth: 1 },
  net: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  netValue: { fontSize: 24, lineHeight: 30, letterSpacing: -0.5 },
  section: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, borderTopWidth: 1 },
  centered: { textAlign: 'center' },
});
