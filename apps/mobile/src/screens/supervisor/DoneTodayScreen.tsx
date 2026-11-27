import { toDisplayQty, unitLabel } from '@tonnage/shared';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { istClock, istShortDay } from '../../format/time';
import { doneRows, useDeviceSnapshot } from '../../offline/useDeviceData';
import { syncNow, useSyncStatus } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import { EmptyState, Group, Icon, Row, Screen, Text } from '../../ui';
import { usePlantTitle } from './usePlantTitle';
import { TourTarget } from '../../onboarding/TourTarget';

/**
 * Canvas 35: trucks weighed today at this plant, from the device store, with the total net. TON-57:
 * each one awaits the office's approval until it is dispatched.
 */
export function DoneTodayScreen() {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const place = usePlantTitle();
  const snap = useDeviceSnapshot();
  const lastSyncAt = useSyncStatus((s) => s.lastSyncAt);
  const [refreshing, setRefreshing] = useState(false);
  const done = snap ? doneRows(snap) : null;
  // The day of the last sync (the server's "today"), or this phone's clock before one.
  const day = istShortDay(lastSyncAt ? Date.parse(lastSyncAt) : Date.now());

  return (
    <Screen
      edges={['top']}
      refresh={{
        refreshing,
        onRefresh: () => {
          setRefreshing(true);
          void syncNow().finally(() => setRefreshing(false));
        },
      }}
    >
      <View>
        <Text variant="caption">{place ? `${place} · ${day}` : day}</Text>
        <Text variant="title" accessibilityRole="header" style={styles.title}>
          Done today
        </Text>
      </View>

      {done === null ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      ) : (
        <>
          <View style={[styles.totals, { backgroundColor: t.card, borderColor: t.bd }]}>
            <View
              style={styles.total}
              accessible
              accessibilityLabel={`Trucks weighed, ${done.rows.length}`}
            >
              <Text variant="caption">Trucks weighed</Text>
              <Text numeric weight="semibold" color="brt" style={styles.big}>
                {String(done.rows.length)}
              </Text>
            </View>
            <View
              style={[styles.total, styles.split, { borderLeftColor: t.bd }]}
              accessible
              accessibilityLabel={`Net loaded, ${toDisplayQty(done.totalNetKg, basis, { withUnit: true })}`}
            >
              <Text variant="caption">Net loaded</Text>
              <Text numeric weight="semibold" color="okt" style={styles.big}>
                {toDisplayQty(done.totalNetKg, basis)}
                <Text variant="caption">{` ${unitLabel(basis)}`}</Text>
              </Text>
            </View>
          </View>

          {done.waiting > 0 ? (
            <View
              accessible
              accessibilityLiveRegion="polite"
              style={[styles.waiting, { backgroundColor: t.wns }]}
            >
              <Icon name="clock" size={18} color={t.wnt} />
              <Text color="wnt" style={[styles.fill, styles.small]}>
                <Text weight="medium" color="wnt" style={styles.small}>
                  {`${done.waiting} waiting to sync`}
                </Text>
                {' · saved safely on this phone'}
              </Text>
            </View>
          ) : null}

          {done.rows.length === 0 ? (
            <EmptyState
              icon="check"
              title="Nothing weighed yet"
              body="Trucks you weigh today show here."
            />
          ) : (
            <TourTarget id="done.list">
            <Group>
              {done.rows.map((r) => {
                const status = r.approved ? 'Dispatched' : r.synced ? 'Awaiting approval' : null;
                const detail = [r.customerName, r.productName ?? r.subOrderNumber, status]
                  .filter(Boolean)
                  .join(' · ');
                const net = toDisplayQty(r.netKg, basis);
                return (
                  <Row
                    key={r.truckId}
                    accessibilityLabel={`${r.vehicleNo}, ${istClock(r.at)}, ${detail}, net ${net} ${unitLabel(basis)}, ${r.synced ? 'synced' : 'waiting to sync'}`}
                  >
                    <Text numeric variant="caption" style={styles.time}>
                      {istClock(r.at)}
                    </Text>
                    <View style={styles.fill}>
                      <Text weight="medium">{r.vehicleNo}</Text>
                      <Text variant="caption" numberOfLines={1}>
                        {detail}
                      </Text>
                    </View>
                    <Text numeric weight="semibold" color="okt">
                      {net}
                    </Text>
                    <View
                      style={[styles.sync, { backgroundColor: r.synced ? t.oks : t.wns }]}
                    >
                      <Icon
                        name={r.synced ? 'check' : 'clock'}
                        size={14}
                        color={r.synced ? t.okt : t.wnt}
                        strokeWidth={2}
                      />
                    </View>
                  </Row>
                );
              })}
            </Group>
            </TourTarget>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  title: { marginTop: 2 },
  totals: { flexDirection: 'row', paddingVertical: 16, paddingHorizontal: 4, borderRadius: 16, borderWidth: 1 },
  total: { flex: 1, paddingHorizontal: 12 },
  split: { borderLeftWidth: 1 },
  big: { fontSize: 24, lineHeight: 30, marginTop: 2 },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  small: { fontSize: 13, lineHeight: 18 },
  time: { width: 40 },
  sync: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
