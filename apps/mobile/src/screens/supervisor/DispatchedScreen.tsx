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
 * Canvas 13 after "Save gross · mark dispatched": the net, and the loading slip number once the
 * server has it ("Waiting for network" until then). The order progress bar, WhatsApp updates and
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

  const left = place
    ? `${view.vehicleNo} left ${place} at ${istClock(view.at)}`
    : `${view.vehicleNo} left at ${istClock(view.at)}`;

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.top}>
        <View style={[styles.check, { backgroundColor: t.oks }]}>
          <Icon name="check" size={36} color={t.okt} strokeWidth={2} />
        </View>
        <Text variant="title" accessibilityRole="header">
          Dispatched
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
          accessibilityLabel={`Loading slip, ${view.slipNo ?? (view.sync === 'rejected' ? 'needs the owner' : 'waiting for network')}`}
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
          ) : (
            <Badge kind="wn" dot>
              Waiting for network
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
