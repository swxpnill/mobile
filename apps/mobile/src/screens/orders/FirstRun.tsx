import { can } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useCompanies } from '../../api/hooks/companies';
import { useParties, useProducts } from '../../api/hooks/masters';
import { useMe } from '../../api/hooks/me';
import { useUsers } from '../../api/hooks/users';
import { useTheme } from '../../theme/ThemeProvider';
import { EmptyState, Group, Icon, Row, Text } from '../../ui';

/**
 * Canvas board 38: no orders yet. Booking roles get the first steps and a setup checklist built
 * from what already exists (the owner also sees "Invite your staff").
 */
export function FirstRun({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const { t } = useTheme();
  const { data: me } = useMe();
  const owner = me ? can(me.role, 'users.manage') : false;
  const { data: companies } = useCompanies();
  const { data: products } = useProducts({}, canCreate);
  const { data: parties } = useParties({}, canCreate);
  const { data: users } = useUsers(owner);

  if (!canCreate) {
    return <EmptyState icon="orders" title="No orders yet" body="Orders for your plant show here as soon as they are booked." />;
  }
  const steps = [
    { label: 'Add your companies & units', done: (companies?.length ?? 0) > 0, go: '/companies' },
    { label: 'Add products and conversions', done: (products?.length ?? 0) > 0, go: '/products' },
    { label: 'Add customers, brokers, transporters', done: (parties?.some((p) => p.type === 'customer') ?? false), go: '/parties' },
    ...(owner ? [{ label: 'Invite your staff', done: (users?.length ?? 0) > 1, go: '/users' }] : []),
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <View style={styles.wrap}>
      <EmptyState
        icon="orders"
        title="No orders yet"
        body="Create your first order, or bring your current Excel sheet in and keep working from where you are."
        actions={[{ label: 'Create first order', onPress: () => router.push('/new') }]}
      />
      <Text variant="caption" style={styles.soon}>
        Import from Excel arrives in a later update.
      </Text>
      <Text variant="overline">{`Getting set up · ${done} of ${steps.length} done`}</Text>
      <Group>
        {steps.map((s, i) => (
          <Row key={s.label} onPress={s.done ? undefined : () => router.push(s.go)} accessibilityLabel={`${s.label}${s.done ? ', done' : ''}`}>
            <View style={[styles.mark, { backgroundColor: s.done ? t.oks : t.ctl }]}>
              {s.done ? <Icon name="check" size={14} color={t.okt} /> : <Text variant="caption" weight="semibold">{String(i + 1)}</Text>}
            </View>
            <Text weight="medium" color={s.done ? 'tx2' : 'tx'} style={styles.fill}>
              {s.label}
            </Text>
            {s.done ? null : <Icon name="chevronRight" size={18} color={t.tx3} />}
          </Row>
        ))}
      </Group>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  soon: { textAlign: 'center', marginTop: -4 },
  mark: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
});
