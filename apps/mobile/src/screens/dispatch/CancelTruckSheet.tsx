import { TRUCK_CANCEL_REASONS, type Truck } from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useCancelTruck } from '../../api/hooks/trucks';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { Button, Chip, showToast, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { MSG, messageFor } from '../messages';

type Reason = (typeof TRUCK_CANCEL_REASONS)[number];

/** Cancel one truck: a reason chip (required) and an optional note; versioned, so never twice. */
export function CancelTruckSheet({
  truck,
  visible,
  onClose,
  onCancelled,
}: {
  truck: Pick<Truck, 'id' | 'vehicleNo' | 'version' | 'tareKg'>;
  visible: boolean;
  onClose(): void;
  onCancelled?(): void;
}) {
  const cancel = useCancelTruck();
  const once = useSingleFlight();
  const key = useSubmitKey();
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!visible) return;
    setReason(null);
    setNote('');
    setError(undefined);
  }, [visible]);

  const send = async () => {
    if (!reason) {
      setError('Choose a reason');
      return;
    }
    setError(undefined);
    try {
      await cancel.mutateAsync({ id: truck.id, key: key.key(), body: { reason, note, version: truck.version } });
      key.settle();
      showToast(`${truck.vehicleNo} cancelled`);
      onClose();
      onCancelled?.();
    } catch (e) {
      key.settle(e); // kept for the retry unless the server answered
      if (e instanceof ApiError && e.code === 'STALE') {
        showToast(MSG.stale);
        onClose();
      } else if (e instanceof ApiError && e.code === 'TRUCK_LOCKED') {
        setError('This truck is already dispatched or cancelled.');
      } else setError(messageFor(e));
    }
  };

  return (
    <Sheet visible={visible} title={`Cancel ${truck.vehicleNo}?`} onClose={onClose} busy={cancel.isPending}>
      <Text color="tx2">The plant supervisor loses this weighing task. Weighments already taken stay on record.</Text>
      {truck.tareKg !== null ? (
        <Text variant="caption" color="wnt">
          The tare is taken: call the plant first, the truck may already be loaded.
        </Text>
      ) : null}
      <Text variant="caption" weight="medium">
        Reason
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {TRUCK_CANCEL_REASONS.map((r) => (
          <Chip key={r} label={r} selected={reason === r} onPress={() => setReason(r)} />
        ))}
      </ScrollView>
      <TextField label="Note" hideLabel placeholder="Note (optional)" value={note} onChangeText={setNote} maxLength={200} />
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.buttons}>
        <Button variant="secondary" disabled={cancel.isPending} onPress={onClose}>
          Keep truck
        </Button>
        <Button variant="danger" loading={cancel.isPending} onPress={() => void once(send)} style={styles.fill}>
          Cancel this truck
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  chips: { gap: 8 },
  buttons: { flexDirection: 'row', gap: 10 },
});
