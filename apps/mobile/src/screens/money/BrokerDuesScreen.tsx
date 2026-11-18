import type { BrokerDues } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { memo, useCallback } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useBrokerDues } from '../../api/hooks/money';
import { useTheme } from '../../theme/ThemeProvider';
import { Avatar, Badge, Button, EmptyState, Group, Row, Screen, Text } from '../../ui';
import { BackHeader } from '../admin/parts';
import { messageFor } from '../messages';
import { dueText } from './captions';

type DueItem = BrokerDues['items'][number];

/** More → Broker ledger (Ruling 8): every broker with what is due, highest first; rows as board 18. */
export function BrokerDuesScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const dues = useBrokerDues();
  const open = useCallback((id: string) => router.push(`/parties/${id}`), [router]);

  return (
    <Screen title="Broker ledger" header={<BackHeader />} refresh={{ refreshing: dues.isRefetching, onRefresh: () => void dues.refetch() }}>
      {dues.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading brokers" />
      ) : dues.isError ? (
        <View style={styles.gap}>
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(dues.error)}
          </Text>
          <Button variant="secondary" onPress={() => void dues.refetch()}>
            Try again
          </Button>
        </View>
      ) : dues.data.items.length === 0 ? (
        <EmptyState icon="wallet" title="No brokers yet" body="Brokers you add under Customers & brokers show here with what is due to them." />
      ) : (
        <Group>
          {dues.data.items.map((b) => (
            <DuesRow key={b.brokerId} b={b} onOpen={open} />
          ))}
        </Group>
      )}
    </Screen>
  );
}

const DuesRow = memo(function DuesRow({ b, onOpen }: { b: DueItem; onOpen(id: string): void }) {
  const due = dueText(b.dueRupees);
  return (
    <Row onPress={() => onOpen(b.brokerId)} accessibilityLabel={`${b.name}, ${b.city}, ${due.text}${b.active ? '' : ', inactive'}`}>
      <Avatar name={b.name} tone={b.active ? 'vi' : 'nu'} />
      <View style={styles.fill}>
        <Text weight="medium" numberOfLines={1}>
          {b.name}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {b.city}
        </Text>
      </View>
      {b.active ? null : <Badge kind="nu">Inactive</Badge>}
      <Text weight="semibold" numeric color={due.color}>
        {due.text}
      </Text>
    </Row>
  );
});

const styles = StyleSheet.create({
  gap: { gap: 12 },
  fill: { flex: 1, minWidth: 0 },
});
