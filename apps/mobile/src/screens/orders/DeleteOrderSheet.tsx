import { type Order, toDisplayQty } from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useDisplayBasis } from '../../api/hooks/me';
import { useDeleteOrder, useDeletePreview } from '../../api/hooks/orders';
import { useSingleFlight } from '../../api/submitKey';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, Icon, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { messageFor } from '../messages';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Canvas board 32: what will be erased, with real counts, and the order number typed back
 * (case and spaces forgiven). Owner only; the server re-checks the number and the tenant flag.
 */
export function DeleteOrderSheet({
  order,
  visible,
  onClose,
  onDeleted,
}: {
  order: Order;
  visible: boolean;
  onClose(): void;
  onDeleted(): void;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const preview = useDeletePreview(order.id, visible);
  const del = useDeleteOrder();
  const once = useSingleFlight();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (visible) {
      setTyped('');
      setError(undefined);
    }
  }, [visible]);

  const matches = typed.trim().toUpperCase() === order.number.toUpperCase();
  const p = preview.data;

  const run = async () => {
    setError(undefined);
    try {
      await del.mutateAsync({ id: order.id, confirmNumber: typed });
      onDeleted();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'HARD_DELETE_DISABLED'
          ? 'Deleting orders with dispatches is turned off in Settings.'
          : messageFor(e),
      );
    }
  };

  const item = (text: string) => (
    <View key={text} style={styles.item}>
      <Icon name="close" size={16} color={t.dgt} />
      <Text style={styles.fill}>{text}</Text>
    </View>
  );

  return (
    <Sheet visible={visible} title={`Delete ${order.number} forever?`} onClose={onClose} busy={del.isPending}>
      <Text color="tx2">
        This erases the order from everywhere. It can’t be undone, and the app will no longer match Tally for this order.
      </Text>
      <Text variant="overline">What will be erased</Text>
      {p ? (
        <View style={styles.list}>
          {item(`${plural(p.subOrders, 'sub-order')} and ${plural(p.lines, 'order line')}`)}
          {p.trucks > 0
            ? item(`${plural(p.trucks, 'truck record')}${p.dispatchedKg > 0 ? ` · ${toDisplayQty(p.dispatchedKg, basis, { withUnit: true })} dispatched` : ''}`)
            : null}
          {p.weighments > 0 ? item('Weighments, loading slips and LR numbers') : null}
          {item('WhatsApp history and activity log')}
        </View>
      ) : (
        <ActivityIndicator color={t.br} accessibilityLabel="Counting records" />
      )}
      <TextField
        label={`Type ${order.number} to confirm`}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={40}
      />
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.buttons}>
        <Button variant="secondary" disabled={del.isPending} onPress={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!matches || !p} loading={del.isPending} onPress={() => void once(run)} style={styles.fill}>
          Delete forever
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  item: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  fill: { flex: 1, minWidth: 0 },
  buttons: { flexDirection: 'row', gap: 10 },
});
