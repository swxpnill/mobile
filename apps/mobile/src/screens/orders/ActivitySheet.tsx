import { useDisplayBasis } from '../../api/hooks/me';
import { useOrderActivity } from '../../api/hooks/orders';
import { relativeTime } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { toDisplayQty, type ActivityEntry } from '@tonnage/shared';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Group, Row, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { messageFor } from '../messages';

/** Plain-language line for an activity entry ("Short closed sub-order A · Rate changed"). */
export function describe(e: ActivityEntry, basis: ReturnType<typeof useDisplayBasis>): string {
  const m = e.meta ?? {};
  const suffix = typeof m.suffix === 'string' ? ` ${m.suffix}` : '';
  switch (e.action) {
    case 'order.created':
      return 'Booked the order';
    case 'order.edited':
      return 'Edited the order';
    case 'order.short_closed':
      return `Short closed sub-order${suffix}${typeof m.reason === 'string' ? ` · ${m.reason}` : ''}`;
    case 'order.sub_cancelled':
      return `Cancelled sub-order${suffix}${typeof m.reason === 'string' ? ` · ${m.reason}` : ''}`;
    case 'order.reopened':
      return `Reopened sub-order${suffix}`;
    case 'order.quantity_moved':
      return `Moved ${typeof m.kg === 'number' ? toDisplayQty(m.kg, basis, { withUnit: true }) : 'quantity'} from ${String(m.fromSuffix ?? '')} to ${String(m.toSuffix ?? '')}`;
    case 'order.duplicated':
      return 'Duplicated as a new draft';
    default:
      return e.action.replace(/^order\./, '').replace(/_/g, ' ');
  }
}

/** Who changed what, and when — newest first. */
export function ActivitySheet({ orderId, visible, onClose }: { orderId: string; visible: boolean; onClose(): void }) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const q = useOrderActivity(orderId, visible);
  const now = Date.now();
  return (
    <Sheet visible={visible} title="Activity history" onClose={onClose}>
      {q.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      ) : q.isError ? (
        <Text color="tx2">{messageFor(q.error)}</Text>
      ) : (
        <Group>
          {(q.data ?? []).map((e) => (
            <Row key={e.id}>
              <View style={styles.fill}>
                <Text weight="medium">{describe(e, basis)}</Text>
                <Text variant="caption">{`${e.actorName} · ${relativeTime(e.at, now)}`}</Text>
              </View>
            </Row>
          ))}
        </Group>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minWidth: 0 } });
