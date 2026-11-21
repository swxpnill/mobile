import { type Truck, toDisplayQty } from '@tonnage/shared';
import { StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { istClock, relativeTime } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { type Tokens } from '../../theme/tokens';
import { Group, Text } from '../../ui';
import { TRUCK_STATE_META, TRUCK_STEPS, stepIndex } from './truckStateMeta';

const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** Which of Assigned → Tare → Gross → Dispatched the truck has reached (1-based). */
/** Canvas 09 "Progress": the five steps (TON-57) and when each happened. */
export function Progress({ x }: { x: Truck }) {
  const { t } = useTheme();
  const meta = TRUCK_STATE_META[x.state];
  const step = stepIndex(x);
  const at = (iso: string | null) => (iso ? istClock(iso) : null);
  const tare = x.weighments.find((w) => w.kind === 'tare' && !w.superseded);
  const gross = x.weighments.find((w) => w.kind === 'gross' && !w.superseded);
  const rows: { label: string; when: string | null }[] = [
    { label: 'Assigned', when: `${at(x.assignedAt)} · ${first(x.assignedBy.name)}` },
    ...(x.atGateAt ? [{ label: 'Arrived', when: at(x.atGateAt) }] : []),
    ...(x.tareAt ? [{ label: 'Tare weighed', when: [at(x.tareAt), tare ? first(tare.by.name) : null].filter(Boolean).join(' · ') }] : []),
    // TON-57: weights saved at the plant, then the office's approval (the dispatch).
    ...(x.weighedAt ? [{ label: 'Weighed', when: [at(x.weighedAt), gross ? first(gross.by.name) : null].filter(Boolean).join(' · ') }] : []),
    ...(x.dispatchedAt ? [{ label: 'Approved · dispatched', when: at(x.dispatchedAt) }] : []),
    ...(x.cancelledAt ? [{ label: 'Cancelled', when: at(x.cancelledAt) }] : []),
  ];
  const next =
    x.state === 'assigned'
      ? 'Next · the vehicle arrives, then the tare'
      : x.state === 'at_gate'
      ? 'Next · tare weight, then loading'
      : x.state === 'loading'
        ? 'Next · gross weight, then the office approves'
        : x.state === 'weighed'
          ? 'Next · the office approves the dispatch'
          : null;
  const colorOf = (i: number): string =>
    x.state === 'cancelled' ? t.act : i < step ? t.ok : i === step && x.state !== 'dispatched' ? t.wn : t.act;
  const fg: keyof Tokens = meta.kind === 'wn' ? 'wnt' : meta.kind === 'ok' ? 'okt' : meta.kind === 'vi' ? 'vi' : meta.kind === 'br' ? 'brt' : 'tx2';
  return (
    <>
      <Text variant="heading">Progress</Text>
      <Group>
        <View style={styles.card}>
          <View style={styles.kv}>
            <Text weight="semibold" color={fg} style={styles.fill}>
              {meta.label}
            </Text>
            <Text variant="caption">{`Step ${step} of ${TRUCK_STEPS.length} · ${TRUCK_STEPS[step - 1]}`}</Text>
          </View>
          <View style={styles.bar} accessible accessibilityLabel={`Progress: step ${step} of ${TRUCK_STEPS.length}, ${TRUCK_STEPS[step - 1]}`}>
            {TRUCK_STEPS.map((s, i) => (
              <View key={s} style={[styles.seg, { backgroundColor: colorOf(i) }]} />
            ))}
          </View>
          <View style={[styles.list, { borderTopColor: t.bd }]}>
            {rows.map((r) => (
              <View key={r.label} style={styles.kv}>
                <Text color="tx2" style={styles.fill}>
                  {r.label}
                </Text>
                <Text variant="caption">{r.when ?? ''}</Text>
              </View>
            ))}
            {next ? <Text variant="caption">{next}</Text> : null}
          </View>
        </View>
      </Group>
    </>
  );
}

/** Every weighment, oldest first; replaced ones struck through, a gate clock far off flagged. */
export function Weighments({ x }: { x: Truck }) {
  const basis = useDisplayBasis();
  if (x.weighments.length === 0) return null;
  const now = Date.now();
  const rows = [...x.weighments].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  return (
    <>
      <Text variant="heading">Weighments</Text>
      <Group>
        {rows.map((w) => {
          const kind = w.kind === 'tare' ? 'Tare' : 'Gross';
          const value = toDisplayQty(w.kg, basis, { withUnit: true });
          return (
            <View
              key={w.id}
              style={styles.row}
              accessible
              accessibilityLabel={`${kind} ${value}, ${w.by.name}, ${relativeTime(w.capturedAt, now)}${w.superseded ? ', replaced' : ''}${w.clockSkew ? ', phone clock was off' : ''}`}
            >
              <View style={styles.fill}>
                <Text weight="medium" color={w.superseded ? 'tx3' : 'tx'} style={w.superseded ? styles.struck : null}>
                  {`${kind} · ${value}`}
                </Text>
                <Text variant="caption">{`${w.by.name} · ${istClock(w.capturedAt)}${w.superseded ? ' · replaced' : ''}`}</Text>
                {w.clockSkew ? (
                  <Text variant="caption" color="wnt">
                    Phone clock was off when this was weighed
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14 },
  kv: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  fill: { flex: 1, minWidth: 0 },
  bar: { flexDirection: 'row', gap: 4 },
  seg: { flex: 1, height: 6, borderRadius: 3 },
  list: { gap: 10, paddingTop: 14, borderTopWidth: 1 },
  row: { flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 16 },
  struck: { textDecorationLine: 'line-through' },
});
