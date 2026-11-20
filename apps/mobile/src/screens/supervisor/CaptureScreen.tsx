import { MAX_READING_KG, type Task, parseQtyInput, toDisplayQty, weightKgSchema } from '@tonnage/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { type NewCapture } from '../../offline/deviceStore';
import { useDeviceSnapshot } from '../../offline/useDeviceData';
import { recordCapture, useDeviceStore } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, type Tokens } from '../../theme/tokens';
import {
  Button,
  EmptyState,
  Group,
  Icon,
  Keypad,
  Screen,
  Text,
  WeightReadout,
  showToast,
} from '../../ui';
import { LineWeightsStep } from './LineWeightsStep';
import { useMarkArrived } from './useMarkArrived';

import { SAVED_ON_PHONE, SAVE_FAILED } from './saveMessages';

export { SAVED_ON_PHONE, SAVE_FAILED };

export type CaptureMode = 'tare' | 'gross';

/**
 * Tare (canvas 36, violet) or gross (canvas 12, blue) for one truck. The task comes in as a prop
 * (the supervisor's device store, or the owner's truck in Task 9); this screen does not care
 * where from. Saving writes one outbox row in one device-store transaction, says "Saved on this
 * phone" only after it committed, and starts a sync.
 */
export function CaptureScreen({
  task,
  mode,
  tareAt,
  onSaved,
  ensureTask,
}: {
  task: Task;
  /**
   * The server's task to put on this phone with the save, in the same transaction (the owner
   * weighing from Dispatch: the truck may not have reached this phone's store yet).
   */
  ensureTask?: Task;
  mode: CaptureMode;
  /** When the tare was weighed (for "Tare · weighed 10:12"); null when unknown. */
  tareAt: string | null;
  /** After the save; default: back to My tasks (tare) or on to Dispatched (gross). */
  onSaved?: () => void;
}) {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const store = useDeviceStore((s) => s.store);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const busy = useRef(false);

  const gross = mode === 'gross';
  // Tare only: the gross is calculated from the product weights (LineWeightsStep, TON-57).
  const parsed = parseQtyInput(value, basis);
  const kg = parsed.ok ? parsed.value : null;
  const problem =
    kg !== null && kg > MAX_READING_KG ? `A reading is at most ${toDisplayQty(MAX_READING_KG, basis, { withUnit: true })}` : null;
  const canSave = weightKgSchema.safeParse(kg).success && problem === null && !saving;

  async function save(payload: NewCapture['payload']) {
    if (busy.current) return;
    if (!store) {
      setError(SAVE_FAILED);
      return;
    }
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const at = new Date().toISOString();
      let taskOpt = ensureTask ? { task: ensureTask } : undefined;
      // TON-57: the server takes a tare only after "Vehicle arrived". Weighing a truck still
      // marked assigned (the owner from Dispatch detail) records the arrival first, same moment.
      if (!gross && task.state === 'assigned') {
        await recordCapture(store, { eventId: Crypto.randomUUID(), truckId: task.truckId, type: 'AT_GATE', payload: {}, capturedAtDevice: at }, taskOpt);
        taskOpt = undefined;
      }
      await recordCapture(store, {
        eventId: Crypto.randomUUID(),
        truckId: task.truckId,
        type: gross ? 'GROSS' : 'TARE',
        payload,
        capturedAtDevice: at,
      }, taskOpt);
      showToast(SAVED_ON_PHONE);
      if (onSaved) onSaved();
      else if (gross) router.replace(`/dispatched/${task.truckId}`);
      else router.back();
    } catch {
      busy.current = false;
      setSaving(false);
      setError(SAVE_FAILED);
    }
  }

  function onPrimary() {
    if (canSave && kg !== null) void save({ tareKg: kg });
  }

  const heading = gross ? 'Weigh products' : 'Tare weight';

  return (
    <Screen
      header={
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to my tasks"
            onPress={() => router.back()}
            style={({ pressed }) => [styles.back, pressed ? { backgroundColor: t.act } : null]}
          >
            <Icon name="back" color={t.tx2} />
          </Pressable>
          <View style={styles.fill}>
            <Text weight="medium" accessibilityRole="header" style={styles.heading}>
              {heading}
            </Text>
            <Text variant="caption">{`${task.vehicleNo} · ${task.subOrderNumber}`}</Text>
          </View>
        </View>
      }
      contentStyle={styles.content}
    >
      <Steps current={gross ? 4 : 3} violet={!gross} />

      {gross ? (
        <>
          <LineWeightsStep
            task={task}
            basis={basis}
            tareAt={tareAt}
            saving={saving}
            onSave={(r) => void save({ grossKg: r.grossKg, allocations: r.allocations })}
          />
          {error ? (
            <Text color="dgt" accessibilityRole="alert" style={styles.center}>
              {error}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <View style={styles.readout}>
            <Text variant="caption" style={styles.center}>
              Empty truck on the weighbridge
            </Text>
            <WeightReadout value={value} basis={basis} color="vi" />
          </View>
          <TareSummary task={task} />
          <View style={styles.spacer} />
          {problem ? (
            <Text color="dgt" accessibilityLiveRegion="polite" style={styles.center}>
              {problem}
            </Text>
          ) : null}
          {error ? (
            <Text color="dgt" accessibilityRole="alert" style={styles.center}>
              {error}
            </Text>
          ) : null}
          <Button variant="violet" disabled={!canSave} loading={saving} onPress={onPrimary}>
            Save tare · start loading
          </Button>
          <Keypad value={value} onChange={setValue} basis={basis} />
        </>
      )}
    </Screen>
  );
}

const STEPS = ['Assigned', 'Arrived', 'Tare', 'Gross', 'Approval'] as const;

/**
 * Canvas step strip: done steps as ticks only (five steps do not fit a phone with every label),
 * the current one filled (violet on tare) and named, the ones ahead numbered and named.
 */
function Steps({ current, violet }: { current: number; violet: boolean }) {
  const { t } = useTheme();
  return (
    <View
      style={styles.steps}
      accessible
      accessibilityLabel={`Progress: step ${current} of ${STEPS.length}, ${STEPS[current - 1]}`}
    >
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const on = n === current;
        const dotBg = done ? t.oks : on ? (violet ? t.vi : t.inv) : t.ctl;
        const dotFg: keyof Tokens = done ? 'okt' : on ? (violet ? 'vitx' : 'invtx') : 'tx3';
        const labelColor: keyof Tokens = on ? (violet ? 'vi' : 'tx') : done ? 'tx2' : 'tx3';
        return (
          <View key={label} style={done ? styles.stepDone : styles.step}>
            <View style={[styles.dot, { backgroundColor: dotBg }]}>
              <Text weight="semibold" color={dotFg} style={styles.dotText}>
                {done ? '✓' : String(n)}
              </Text>
            </View>
            {done ? null : (
              <Text variant="caption" weight="medium" color={labelColor} numberOfLines={1} style={styles.stepLabel}>
                {label}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

function TareSummary({ task }: { task: Task }) {
  const basis = useDisplayBasis();
  const who = [task.customerName, task.transporterName, task.driverName].filter(Boolean).join(' · ');
  return (
    <Group style={styles.summary}>
      <Text variant="caption">After tare, load</Text>
      {task.plan.map((p) => (
        <View key={p.orderLineId} style={styles.kv}>
          <Text weight="medium" style={styles.fill}>
            {p.productName}
          </Text>
          <Text numeric weight="semibold">
            {toDisplayQty(p.plannedKg, basis, { withUnit: true })}
          </Text>
        </View>
      ))}
      {who ? <Text variant="caption">{who}</Text> : null}
    </Group>
  );
}

/**
 * The supervisor's route: the task from this phone's device store (`displayTasks`), tare or gross
 * by its state. Keeps showing the truck while the save navigates away (it leaves the list).
 */
export function WeighTruckScreen({ truckId }: { truckId: string }) {
  const router = useRouter();
  const { t } = useTheme();
  const snap = useDeviceSnapshot();
  const found = snap?.shown.find((x) => x.truckId === truckId);
  const last = useRef<{ task: Task; mode: CaptureMode; tareAt: string | null } | null>(null);
  if (found) {
    last.current = {
      task: found,
      // The mode is fixed when the screen opens: a tare saved here must not flip it to gross.
      mode: last.current?.mode ?? (found.state === 'loading' ? 'gross' : 'tare'),
      // A pending local tare's time (displayTasks), else the server's; never `changedAt`, which
      // edits and restores also move.
      tareAt: found.tareKg === null ? null : found.tareAt,
    };
  }
  const shown = last.current;
  const arrival = useMarkArrived();

  if (!shown) {
    if (snap === null)
      return (
        <Screen>
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        </Screen>
      );
    return (
      <Screen>
        <EmptyState
          icon="truck"
          title="This truck is not on your list"
          body="It may have been cancelled, or weighed on another phone."
          actions={[{ label: 'Back to my tasks', onPress: () => router.back() }]}
        />
      </Screen>
    );
  }
  // TON-57: the tare waits for "Vehicle arrived" (a link or notification may open this early).
  if (shown.mode === 'tare' && shown.task.state === 'assigned') {
    return (
      <Screen>
        <EmptyState
          icon="truck"
          title="Mark the vehicle arrived first"
          body={`${shown.task.vehicleNo} is weighed once it is at the plant.`}
          actions={[
            { label: 'Vehicle arrived', onPress: () => void arrival.mark(shown.task.truckId) },
            { label: 'Back to my tasks', onPress: () => router.back() },
          ]}
        />
      </Screen>
    );
  }
  return <CaptureScreen task={shown.task} mode={shown.mode} tareAt={shown.tareAt} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingTop: 12,
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  back: {
    width: MIN_TOUCH + 4,
    height: MIN_TOUCH + 4,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: { fontSize: 15, lineHeight: 20 },
  content: { paddingTop: 12, paddingBottom: 20, gap: 16 },
  steps: { flexDirection: 'row', gap: 8 },
  step: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  stepDone: { flexDirection: 'row', alignItems: 'center' },
  stepLabel: { flexShrink: 1 },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontSize: 11, lineHeight: 14 },
  readout: { paddingTop: 18, paddingBottom: 6, gap: 6 },
  center: { textAlign: 'center' },
  summary: { padding: 16, gap: 10 },
  kv: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  spacer: { flex: 1 },
});
