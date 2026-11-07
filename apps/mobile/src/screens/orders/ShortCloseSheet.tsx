import {
  type OpenTruck,
  type Order,
  SHORT_CLOSE_REASONS,
  type ShortCloseReason,
  type SubOrder,
  formatLength,
  isTerminal,
  openTrucksDetailsSchema,
  toDisplayQty,
  unitLabel,
} from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useDisplayBasis } from '../../api/hooks/me';
import { useShortClose } from '../../api/hooks/orders';
import { useSingleFlight } from '../../api/submitKey';
import { Badge, Button, ChoiceRow, Group, Row, showToast, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { MSG, messageFor } from '../messages';

const TRUCK_STATE: Record<OpenTruck['state'], string> = {
  assigned: 'assigned',
  at_gate: 'at the gate',
  loading: 'loading',
  dispatched: 'dispatched',
  cancelled: 'cancelled',
};

/** "CG 07 BR 8810 — loading, tare 12.460 MT" in the person's unit. */
export function truckLine(t: OpenTruck, basis: ReturnType<typeof useDisplayBasis>): string {
  const tare = t.tareKg !== null ? `, tare ${toDisplayQty(t.tareKg, basis, { withUnit: true })}` : '';
  return `${t.vehicleNo} — ${TRUCK_STATE[t.state]}${tare}`;
}

/**
 * Canvas board 31 + spec §5.3 / answer #25. One sub-order at a time. If trucks are still open, the
 * server refuses with OPEN_TRUCKS and the sheet lists them for a second, explicit confirmation;
 * that confirmed call cancels them and closes in one step.
 */
export function ShortCloseSheet({ order, visible, onClose }: { order: Order; visible: boolean; onClose(): void }) {
  const basis = useDisplayBasis();
  const close = useShortClose();
  const once = useSingleFlight();
  const open = order.subOrders.filter((s) => !isTerminal(s.status));
  const [subId, setSubId] = useState<string | undefined>(open[0]?.id);
  const [reason, setReason] = useState<ShortCloseReason | null>(null);
  const [note, setNote] = useState('');
  const [trucks, setTrucks] = useState<OpenTruck[] | null>(null);
  const [error, setError] = useState<string>();
  const sub: SubOrder | undefined = open.find((s) => s.id === subId) ?? open[0];

  useEffect(() => {
    if (!visible) return;
    setSubId(open[0]?.id);
    setReason(null);
    setNote('');
    setTrucks(null);
    setError(undefined);
  }, [visible]);

  if (!sub) return null;
  const unit = unitLabel(basis);
  const pending = toDisplayQty(sub.totals.pendingKg, basis);
  const dispatched = toDisplayQty(sub.totals.dispatchedKg, basis);

  const send = async (cancelOpenTrucks: boolean) => {
    if (!reason) {
      setError('Choose a reason');
      return;
    }
    setError(undefined);
    try {
      const next = await close.mutateAsync({ subOrderId: sub.id, body: { reason, note, cancelOpenTrucks, version: sub.version } });
      const s = next.subOrders.find((x) => x.id === sub.id);
      showToast(s?.status === 'cancelled' ? `${sub.number} cancelled` : `${sub.number} short closed`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OPEN_TRUCKS') {
        const parsed = openTrucksDetailsSchema.safeParse(e.details);
        setTrucks(parsed.success ? parsed.data.trucks : []);
      } else if (e instanceof ApiError && e.code === 'STALE') {
        showToast(MSG.stale);
        onClose();
      } else setError(messageFor(e));
    }
  };

  if (trucks) {
    const loading = trucks.some((x) => x.tareKg !== null);
    return (
      <Sheet visible={visible} title={`${trucks.length} ${trucks.length === 1 ? 'truck is' : 'trucks are'} still open`} onClose={onClose} busy={close.isPending}>
        <Text color="tx2">{trucks.length === 1 ? 'Short closing cancels it. Its weighments stay on record.' : 'Short closing cancels them. Their weighments stay on record.'}</Text>
        <Group>
          {trucks.map((x) => (
            <Row key={x.id}>
              <View style={styles.fill}>
                <Text weight="medium">{truckLine(x, basis)}</Text>
                {x.tareKg !== null ? (
                  <Text variant="caption" color="wnt">
                    May be loading now
                  </Text>
                ) : null}
              </View>
            </Row>
          ))}
        </Group>
        {loading ? (
          <Text variant="caption" color="wnt">
            Call the plant before you confirm: a truck with its tare taken may already be loaded.
          </Text>
        ) : null}
        {error ? <Text color="dgt">{error}</Text> : null}
        <Button variant="danger" loading={close.isPending} onPress={() => void once(() => send(true))}>
          {`Cancel ${trucks.length} ${trucks.length === 1 ? 'truck' : 'trucks'} and short close`}
        </Button>
        <Button variant="secondary" disabled={close.isPending} onPress={onClose}>
          Keep open
        </Button>
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} title={`Short close ${pending} ${unit}?`} onClose={onClose} busy={close.isPending}>
      <Text color="tx2">
        {sub.totals.dispatchedKg > 0
          ? `${sub.number} stops here. The ${dispatched} ${unit} already dispatched stays on record.`
          : `Nothing was dispatched on ${sub.number}, so it will be recorded as cancelled.`}
      </Text>
      {open.length > 1 ? (
        <Group>
          {open.map((s) => (
            <ChoiceRow
              key={s.id}
              kind="radio"
              title={`${s.companyName} · ${s.suffix}`}
              detail={`${toDisplayQty(s.totals.pendingKg, basis, { withUnit: true })} pending`}
              checked={s.id === sub.id}
              onPress={() => setSubId(s.id)}
            />
          ))}
        </Group>
      ) : null}
      <Group>
        {sub.lines.filter((l) => l.pendingKg > 0).map((l) => (
          <Row key={l.id}>
            <Text style={styles.fill} numberOfLines={1}>{`${l.productName.replace(/^TMT Fe500D/, 'TMT')} · ${formatLength(l.length)}`}</Text>
            <Text weight="medium" numeric>
              {toDisplayQty(l.pendingKg, basis)}
            </Text>
          </Row>
        ))}
      </Group>
      <Text variant="caption" weight="medium">
        Reason
      </Text>
      <Group>
        {SHORT_CLOSE_REASONS.map((r) => (
          <ChoiceRow key={r} kind="radio" title={r} checked={reason === r} onPress={() => setReason(r)} />
        ))}
      </Group>
      <TextField label="Note" hideLabel placeholder="Note (optional)" value={note} onChangeText={setNote} maxLength={200} />
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.buttons}>
        <Button variant="secondary" disabled={close.isPending} onPress={onClose}>
          Keep open
        </Button>
        <Button loading={close.isPending} onPress={() => void once(() => send(false))} style={styles.fill}>
          Short close order
        </Button>
      </View>
      {sub.openTrucks.length > 0 ? (
        <Badge kind="wn">{`${sub.openTrucks.length} open ${sub.openTrucks.length === 1 ? 'truck' : 'trucks'} on this sub-order`}</Badge>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  buttons: { flexDirection: 'row', gap: 10 },
});
