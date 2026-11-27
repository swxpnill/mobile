import { formatMobile, toDisplayQty } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { type DisplayTask, doneRows, useDeviceSnapshot } from '../../offline/useDeviceData';
import { syncNow } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, type Tokens, radius } from '../../theme/tokens';
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
  weightUnit,
} from '../../ui';
import { SyncBanner } from './SyncBanner';
import { useMarkArrived } from './useMarkArrived';
import { usePlantTitle } from './usePlantTitle';
import { TourTarget } from '../../onboarding/TourTarget';

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
  // The tour points at one card per step: the first truck that shows that step.
  const firstAssigned = shown.find((x) => x.state === 'assigned')?.truckId;
  const pointers: TaskPointers = {
    arrived: firstAssigned,
    // A tare button that works now (an arrived truck) teaches more than the locked step.
    tare: shown.find((x) => x.state === 'at_gate')?.truckId ?? firstAssigned,
    weigh: shown.find((x) => x.state === 'loading')?.truckId,
  };

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

      <TourTarget id="tasks.counts">
        <View style={styles.counts}>
          <Count label="Need tare" value={needTare} color="vi" />
          <Count label="Need gross" value={needGross} color="wnt" />
          <Count label="Done today" value={doneCount} color="okt" />
        </View>
      </TourTarget>

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
            pointers={pointers}
            onWeigh={() => router.push(`/weigh/${task.truckId}`)}
          />
        ))
      )}
    </Screen>
  );
}

/**
 * The next step, shown but not yet available (TON-57: tare after arrival): a lock, its name and
 * what unlocks it. A disabled control to a screen reader, so the order of the steps is clear.
 */
function LockedStep({ title, hint }: { title: string; hint: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${hint.toLowerCase()}`}
      accessibilityState={{ disabled: true }}
      style={[styles.locked, { backgroundColor: t.bg, borderColor: t.bd }]}
    >
      <View style={[styles.lockIcon, { backgroundColor: t.ctl }]}>
        <Icon name="lock" size={16} color={t.tx3} strokeWidth={2} />
      </View>
      <View style={styles.fill}>
        <Text weight="semibold" color="tx3">
          {title}
        </Text>
        <Text variant="caption">{hint}</Text>
      </View>
    </View>
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

/** Which card's buttons the supervisor tour highlights (by truck id). */
interface TaskPointers {
  arrived?: string;
  tare?: string;
  weigh?: string;
}

function TaskCard({ task, onWeigh, pointers }: { task: DisplayTask; onWeigh(): void; pointers: TaskPointers }) {
  const mine = (k: keyof TaskPointers) => (pointers[k] === task.truckId ? (`tasks.${k}` as const) : undefined);
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const arrival = useMarkArrived();
  if (task.state !== 'assigned' && task.state !== 'at_gate' && task.state !== 'loading')
    return null;
  const look = STATE_LOOK[task.state];

  let badge: { kind: BadgeKind; text: string };
  if (task.state === 'loading')
    badge =
      task.tareKg === null
        ? { kind: 'wn', text: 'Loading' }
        : { kind: 'br', text: `Tare ${toDisplayQty(task.tareKg, basis)} ${weightUnit(basis)}` };
  else if (task.state === 'at_gate') badge = { kind: 'vi', text: 'Arrived' };
  else badge = { kind: 'nu', text: 'Assigned' };

  const who = [task.transporterName, task.driverName, formatMobile(task.driverPhone)]
    .filter(Boolean)
    .join(' · ');

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
        <TourTarget id={mine('weigh')}>
          <Button onPress={onWeigh}>Capture gross weight</Button>
        </TourTarget>
      ) : task.state === 'assigned' ? (
        // TON-57: the vehicle is marked arrived first; its tare waits until then.
        <>
          <TourTarget id={mine('arrived')}>
            <Button variant="violet" loading={arrival.busy === task.truckId} onPress={() => void arrival.mark(task.truckId)}>
              Vehicle arrived
            </Button>
          </TourTarget>
          <TourTarget id={mine('tare')}>
            <LockedStep title="Capture tare weight" hint="Unlocks when the vehicle arrives" />
          </TourTarget>
        </>
      ) : (
        <TourTarget id={mine('tare')}>
          <Button variant="violet" onPress={onWeigh}>
            Capture tare weight
          </Button>
        </TourTarget>
      )}
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
  countValue: { fontSize: 20, lineHeight: 26, marginTop: 2, textAlign: 'center' },
  card: { padding: 16, gap: 12, borderRadius: 16, borderWidth: 1 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  vehicle: { fontSize: 16, lineHeight: 22 },
  plan: { padding: 12, borderRadius: 12, gap: 6 },
  planRow: { flexDirection: 'row', gap: 12 },
  planLine: { fontSize: 13, lineHeight: 18 },
  locked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: MIN_TOUCH + 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.button,
    borderWidth: 1,
  },
  lockIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
