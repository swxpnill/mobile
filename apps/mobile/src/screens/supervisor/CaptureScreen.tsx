import {
  MAX_READING_KG,
  type Task,
  netKg as netOf,
  parseQtyInput,
  plausibility,
  toDisplayQty,
  weightKgSchema,
} from '@tonnage/shared';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { istClock } from '../../format/time';
import { type NewCapture } from '../../offline/deviceStore';
import { useDeviceSnapshot } from '../../offline/useDeviceData';
import { recordCapture, useDeviceStore } from '../../offline/useSync';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, type Tokens } from '../../theme/tokens';
import {
  Button,
  ConfirmSheet,
  EmptyState,
  Group,
  Icon,
  Keypad,
  Screen,
  Text,
  WeightReadout,
  showToast,
} from '../../ui';
import { type Allocation, SplitStep } from './SplitStep';
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
  const [step, setStep] = useState<'weigh' | 'split'>('weigh');
  const [askPct, setAskPct] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const busy = useRef(false);

  const gross = mode === 'gross';
  const parsed = parseQtyInput(value, basis);
  const kg = parsed.ok ? parsed.value : null;
  const planned = task.plan.reduce((s, p) => s + p.plannedKg, 0);
  const net = gross && kg !== null && task.tareKg !== null ? netOf(kg, task.tareKg) : null;

  let problem: string | null = null;
  if (kg !== null && kg > MAX_READING_KG)
    problem = `A reading is at most ${toDisplayQty(MAX_READING_KG, basis, { withUnit: true })}`;
  else if (gross && task.tareKg === null) problem = 'Weigh the tare first';
  else if (gross && net !== null && net <= 0) problem = 'Gross must be more than the tare';
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

  /** After the plausibility question: split over several lines, or save straight away. */
  function proceed() {
    if (kg === null || net === null) return;
    const [only, ...more] = task.plan;
    if (only && more.length === 0) void save({ grossKg: kg, allocations: [{ orderLineId: only.orderLineId, netKg: net }] });
    else setStep('split');
  }

  function onPrimary() {
    if (!canSave || kg === null) return;
    if (!gross) return void save({ tareKg: kg });
    if (net === null) return;
    if (plausibility(net, planned) !== 'ok') return setAskPct(Math.round((net * 100) / planned));
    proceed();
  }

  const heading = gross ? 'Gross weight' : 'Tare weight';
  // TON-57: the office approves the dispatch; saving the gross sends it to them.
  const action = gross ? 'Save gross · send for approval' : 'Save tare · start loading';

  return (
    <Screen
      header={
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={step === 'split' ? 'Back to the weight' : 'Back to my tasks'}
            onPress={() => (step === 'split' ? setStep('weigh') : router.back())}
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

      {step === 'split' && net !== null && kg !== null ? (
        <SplitStep
          plan={task.plan}
          netKg={net}
          basis={basis}
          saving={saving}
          onSave={(allocations: Allocation[]) => void save({ grossKg: kg, allocations })}
        />
      ) : (
        <>
          <View style={styles.readout}>
            <Text variant="caption" style={styles.center}>
              {gross ? 'Loaded truck on the weighbridge' : 'Empty truck on the weighbridge'}
            </Text>
            <WeightReadout value={value} basis={basis} color={gross ? 'tx' : 'vi'} />
          </View>

          {gross ? (
            <GrossSummary
              grossKg={kg ?? 0}
              tareKg={task.tareKg ?? 0}
              tareAt={tareAt}
              netKg={net}
              plannedKg={planned}
            />
          ) : (
            <TareSummary task={task} />
          )}

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
          <Button
            variant={gross ? 'primary' : 'violet'}
            disabled={!canSave}
            loading={saving}
            onPress={onPrimary}
          >
            {action}
          </Button>
          <Keypad value={value} onChange={setValue} basis={basis} />
        </>
      )}

      {step === 'split' && error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <ConfirmSheet
        visible={askPct !== null}
        title={`Net is ${askPct ?? 0} % of the plan. Save anyway?`}
        body={`Planned ${toDisplayQty(planned, basis, { withUnit: true })}, net ${toDisplayQty(net ?? 0, basis, { withUnit: true })}. Check the reading before you save.`}
        confirmLabel="Save anyway"
        cancelLabel="Check again"
        onCancel={() => setAskPct(null)}
        onConfirm={() => {
          setAskPct(null);
          proceed();
        }}
      />
    </Screen>
  );
}

const STEPS = ['Assigned', 'Arrived', 'Tare', 'Gross', 'Approval'] as const;

/** Canvas step strip: done steps ticked, the current one filled (violet on tare). */
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
          <View key={label} style={styles.step}>
            <View style={[styles.dot, { backgroundColor: dotBg }]}>
              <Text weight="semibold" color={dotFg} style={styles.dotText}>
                {done ? '✓' : String(n)}
              </Text>
            </View>
            <Text variant="caption" weight="medium" color={labelColor} numberOfLines={1}>
              {label}
            </Text>
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

function GrossSummary({
  grossKg,
  tareKg,
  tareAt,
  netKg,
  plannedKg,
}: {
  grossKg: number;
  tareKg: number;
  tareAt: string | null;
  netKg: number | null;
  plannedKg: number;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const q = (kg: number) => toDisplayQty(kg, basis);
  const diff = netKg !== null && netKg > 0 ? netKg - plannedKg : null;
  const look: { bg: keyof Tokens; fg: keyof Tokens; text: string } | null =
    diff === null
      ? null
      : diff > 0
        ? { bg: 'wns', fg: 'wnt', text: `+${q(diff)} over · allowed` }
        : diff < 0
          ? { bg: 'dgs', fg: 'dgt', text: `−${q(-diff)} under · allowed` }
          : { bg: 'oks', fg: 'okt', text: 'Exact' };
  return (
    <Group style={styles.summary}>
      <View style={styles.kv}>
        <Text color="tx2" style={styles.fill}>
          Gross
        </Text>
        <Text numeric weight="medium">
          {q(grossKg)}
        </Text>
      </View>
      <View style={styles.kv}>
        <Text color="tx2" style={styles.fill}>
          {tareAt ? `Tare · weighed ${istClock(tareAt)}` : 'Tare'}
        </Text>
        <Text numeric weight="medium" color="dgt">
          {`− ${q(tareKg)}`}
        </Text>
      </View>
      <View style={[styles.kv, styles.netRow, { borderTopColor: t.bd }]}>
        <Text weight="medium" style={styles.fill}>
          Net loaded
        </Text>
        <Text numeric weight="semibold" color="okt" style={styles.net}>
          {netKg !== null && netKg > 0 ? toDisplayQty(netKg, basis, { withUnit: true }) : '—'}
        </Text>
      </View>
      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={`Planned ${toDisplayQty(plannedKg, basis, { withUnit: true })}${look ? `, ${look.text}` : ''}`}
        style={[styles.diff, { backgroundColor: look ? t[look.bg] : t.ctl }]}
      >
        <Text weight="medium" color={look?.fg ?? 'tx2'} style={[styles.fill, styles.small]}>
          {`Planned ${toDisplayQty(plannedKg, basis, { withUnit: true })}`}
        </Text>
        {look ? (
          <Text numeric weight="semibold" color={look.fg} style={styles.small}>
            {look.text}
          </Text>
        ) : null}
      </View>
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
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontSize: 11, lineHeight: 14 },
  readout: { paddingTop: 18, paddingBottom: 6, gap: 6 },
  center: { textAlign: 'center' },
  summary: { padding: 16, gap: 10 },
  kv: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  netRow: { paddingTop: 10, borderTopWidth: 1 },
  net: { fontSize: 18, lineHeight: 24 },
  diff: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  small: { fontSize: 13, lineHeight: 18 },
  spacer: { flex: 1 },
});
