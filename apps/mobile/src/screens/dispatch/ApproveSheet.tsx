import { type Truck, toDisplayQty } from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useDisplayBasis } from '../../api/hooks/me';
import { useApproveTruck } from '../../api/hooks/trucks';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { istClock } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, showToast, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { MSG, messageFor } from '../messages';
import { planLabel } from './truckStateMeta';

export type ApprovableTruck = Pick<
  Truck,
  'id' | 'vehicleNo' | 'version' | 'state' | 'customerName' | 'subOrderNumber' | 'plantName' | 'tareKg' | 'grossKg' | 'netKg' | 'weighedAt' | 'plan' | 'allocations'
>;

/** "TMT Fe500D · 12 mm · 12 m" for a weighed line; a line off the plan is named generically. */
const lineName = (truck: ApprovableTruck, orderLineId: string) => {
  const p = truck.plan.find((x) => x.orderLineId === orderLineId);
  return p ? planLabel(p) : 'Another product on this order';
};

/**
 * TON-57: the office approves a truck awaiting approval; that is the dispatch. The sheet shows what
 * is being approved (weights per product, tare, gross, net) so the approval is a deliberate act; the
 * loading slip and the broker earning come with it. Keyed (a retry after a lost answer is the same
 * request) and versioned (weights changed meanwhile are never approved unseen).
 */
export function ApproveSheet({
  truck,
  visible,
  onClose,
  onChangeWeights,
}: {
  truck: ApprovableTruck;
  visible: boolean;
  onClose(): void;
  /** Offered when the person may change the weights instead. */
  onChangeWeights?: () => void;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const approve = useApproveTruck();
  const once = useSingleFlight();
  const key = useSubmitKey();
  const [error, setError] = useState<string>();
  const q = (kg: number | null) => (kg === null ? '—' : toDisplayQty(kg, basis, { withUnit: true }));

  useEffect(() => {
    if (visible) setError(undefined);
  }, [visible]);

  const send = async () => {
    setError(undefined);
    try {
      const after = await approve.mutateAsync({ id: truck.id, version: truck.version, key: key.key(`${truck.id}:${truck.version}`) });
      key.settle();
      showToast(after.loadingSlipNo ? `${truck.vehicleNo} dispatched · ${after.loadingSlipNo}` : `${truck.vehicleNo} dispatched`);
      onClose();
    } catch (e) {
      key.settle(e);
      if (e instanceof ApiError && e.code === 'STALE') {
        // The weights or the truck changed since this sheet opened: show the new ones first.
        showToast(MSG.stale);
        onClose();
      } else if (e instanceof ApiError && e.code === 'NOT_AWAITING_APPROVAL') {
        setError('This truck is no longer waiting for approval: it was approved or cancelled.');
      } else setError(messageFor(e));
    }
  };

  return (
    <Sheet visible={visible} title={`Approve ${truck.vehicleNo}?`} onClose={onClose} busy={approve.isPending}>
      <Text color="tx2">
        {`${[truck.customerName, truck.subOrderNumber].filter(Boolean).join(' · ')}. Approving dispatches the truck: the loading slip is issued and the weights count as dispatched.`}
      </Text>
      <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.bd }]}>
        {truck.allocations.map((a) => (
          <View key={a.orderLineId} style={styles.kv} accessible accessibilityLabel={`${lineName(truck, a.orderLineId)}, ${q(a.netKg)}`}>
            <Text style={styles.fill}>{lineName(truck, a.orderLineId)}</Text>
            <Text weight="semibold" numeric>
              {q(a.netKg)}
            </Text>
          </View>
        ))}
        <View style={[styles.kv, styles.rule, { borderTopColor: t.bd }]} accessible accessibilityLabel={`Tare ${q(truck.tareKg)}, gross ${q(truck.grossKg)}`}>
          <Text variant="caption" style={styles.fill}>{`Tare ${q(truck.tareKg)} · gross ${q(truck.grossKg)}`}</Text>
        </View>
        <View style={styles.kv} accessible accessibilityLabel={`Net ${q(truck.netKg)}`}>
          <Text weight="medium" style={styles.fill}>
            Net
          </Text>
          <Text weight="semibold" color="okt" numeric>
            {q(truck.netKg)}
          </Text>
        </View>
        {truck.weighedAt ? <Text variant="caption">{`Weighed at ${truck.plantName} · ${istClock(truck.weighedAt)}`}</Text> : null}
      </View>
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button loading={approve.isPending} onPress={() => void once(send)} accessibilityLabel={`Approve dispatch of ${truck.vehicleNo}`}>
        Approve dispatch
      </Button>
      {onChangeWeights ? (
        <Button
          variant="secondary"
          disabled={approve.isPending}
          onPress={() => {
            onClose();
            onChangeWeights();
          }}
        >
          Change weights first
        </Button>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 8, borderRadius: 12, borderWidth: 1 },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rule: { paddingTop: 8, borderTopWidth: 1 },
  fill: { flex: 1, minWidth: 0 },
});
