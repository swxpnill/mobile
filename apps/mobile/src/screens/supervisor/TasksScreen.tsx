import { formatMobile, toDisplayQty } from '@tonnage/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { type DisplayTask, doneRows, useDeviceSnapshot } from '../../offline/useDeviceData';
import { recordCapture, syncNow, useDeviceStore } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, type Tokens } from '../../theme/tokens';
import {
  Avatar,
  Badge,
  type BadgeKind,
  Button,
  EmptyState,
  Icon,
  type IconName,
  Screen,
  SectionLabel,
  Text,
  showToast,
  weightUnit,
} from '../../ui';
import { SAVE_FAILED } from './CaptureScreen';
import { SyncBanner } from './SyncBanner';
import { usePlantTitle } from './usePlantTitle';

/** Supervisor's My tasks (canvas 11): this plant's trucks, what to weigh next, sync state. */
export function TasksScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const { data: me } = useMe();
  const title = usePlantTitle();
  const snap = useDeviceSnapshot();
  const [refreshing, setRefreshing] = useState(false);

  const shown = snap?.shown ?? [];
  const needTare = shown.filter((x) => x.state === 'assigned' || x.state === 'at_gate').length;
  const needGross = shown.filter((x) => x.state === 'loading').length;
  const doneCount = snap ? doneRows(snap).rows.length : 0;

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
      <View style={styles.head}>
        <View style={styles.fill}>
          <View style={styles.capRow}>
            <Icon name="lock" size={13} color={t.tx3} strokeWidth={2} />
            <Text variant="caption">Your plant · weighing only</Text>
          </View>
          <Text weight="semibold" accessibilityRole="header" style={styles.title}>
            {title ?? 'My tasks'}
          </Text>
        </View>
        {me ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Account — ${me.name}`}
            onPress={() => router.navigate('/profile')}
            style={styles.account}
          >
            <Avatar name={me.name} tone="br" size={40} />
          </Pressable>
        ) : null}
      </View>

      <SyncBanner />

      <View style={styles.counts}>
        <Count label="Need tare" value={needTare} color="vi" />
        <Count label="Need gross" value={needGross} color="wnt" />
        <Count label="Done today" value={doneCount} color="okt" />
      </View>

      <SectionLabel>My tasks · trucks assigned by sales</SectionLabel>
      {snap === null ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading tasks" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="scales"
          title="No trucks to weigh"
          body="Trucks assigned to your plant show here. Pull down to check again."
        />
      ) : (
        shown.map((task) => (
          <TaskCard
            key={task.truckId}
            task={task}
            onWeigh={() => router.push(`/weigh/${task.truckId}`)}
          />
        ))
      )}
    </Screen>
  );
}

function Count({ label, value, color }: { label: string; value: number; color: keyof Tokens }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={[styles.count, { backgroundColor: t.card, borderColor: t.bd }]}
    >
      <Text variant="caption">{label}</Text>
      <Text numeric weight="semibold" color={color} style={styles.countValue}>
        {String(value)}
      </Text>
    </View>
  );
}

const STATE_LOOK: Record<
  'assigned' | 'at_gate' | 'loading',
  { icon: IconName; tile: keyof Tokens; fg: keyof Tokens }
> = {
  assigned: { icon: 'truck', tile: 'brs', fg: 'brt' },
  at_gate: { icon: 'truck', tile: 'vis', fg: 'vi' },
  loading: { icon: 'scales', tile: 'wns', fg: 'wnt' },
};

function TaskCard({ task, onWeigh }: { task: DisplayTask; onWeigh(): void }) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const store = useDeviceStore((s) => s.store);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  if (task.state !== 'assigned' && task.state !== 'at_gate' && task.state !== 'loading')
    return null;
  const look = STATE_LOOK[task.state];

  let badge: { kind: BadgeKind; text: string };
  if (task.state === 'loading')
    badge =
      task.tareKg === null
        ? { kind: 'wn', text: 'Loading' }
        : { kind: 'br', text: `Tare ${toDisplayQty(task.tareKg, basis)} ${weightUnit(basis)}` };
  else if (task.state === 'at_gate') badge = { kind: 'vi', text: 'At gate' };
  else badge = { kind: 'nu', text: 'Assigned' };

  const who = [task.transporterName, task.driverName, formatMobile(task.driverPhone)]
    .filter(Boolean)
    .join(' · ');

  async function atGate() {
    if (!store || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await recordCapture(store, {
        eventId: Crypto.randomUUID(),
        truckId: task.truckId,
        type: 'AT_GATE',
        payload: {},
        capturedAtDevice: new Date().toISOString(),
      });
      showToast('Saved on this phone');
    } catch {
      showToast(SAVE_FAILED);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <View
      accessibilityLabel={`${task.vehicleNo}, ${badge.text}`}
      style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}
    >
      <View style={styles.cardHead}>
        <View style={[styles.tile, { backgroundColor: t[look.tile] }]}>
          <Icon name={look.icon} size={20} color={t[look.fg]} />
        </View>
        <View style={styles.fill}>
          <Text weight="semibold" style={styles.vehicle}>
            {task.vehicleNo}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {who}
          </Text>
        </View>
        <Badge kind={badge.kind} dot>
          {badge.text}
        </Badge>
      </View>

      <View style={[styles.plan, { backgroundColor: t.bg }]}>
        <Text variant="caption" color="tx2" style={styles.planLine}>
          {[task.customerName, task.subOrderNumber].filter(Boolean).join(' · ')}
        </Text>
        {task.plan.map((p) => (
          <View key={p.orderLineId} style={styles.planRow}>
            <Text weight="medium" style={[styles.fill, styles.planLine]}>
              {`Load ${p.productName}`}
            </Text>
            <Text numeric weight="semibold" style={styles.planLine}>
              {toDisplayQty(p.plannedKg, basis, { withUnit: true })}
            </Text>
          </View>
        ))}
      </View>

      {task.state === 'loading' ? (
        <Button onPress={onWeigh}>Capture gross weight</Button>
      ) : (
        <Button variant="violet" onPress={onWeigh}>
          Capture tare weight
        </Button>
      )}
      {task.state === 'assigned' ? (
        <Button variant="secondary" loading={busy} onPress={() => void atGate()}>
          At gate
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  capRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 24, lineHeight: 30, letterSpacing: -0.6, marginTop: 2 },
  account: {
    minWidth: MIN_TOUCH + 4,
    minHeight: MIN_TOUCH + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counts: { flexDirection: 'row', gap: 8 },
  count: { flex: 1, padding: 12, borderRadius: 16, borderWidth: 1 },
  countValue: { fontSize: 20, lineHeight: 26, marginTop: 2 },
  card: { padding: 16, gap: 12, borderRadius: 16, borderWidth: 1 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  vehicle: { fontSize: 16, lineHeight: 22 },
  plan: { padding: 12, borderRadius: 12, gap: 6 },
  planRow: { flexDirection: 'row', gap: 12 },
  planLine: { fontSize: 13, lineHeight: 18 },
});
