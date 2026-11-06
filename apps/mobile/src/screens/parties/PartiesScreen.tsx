import { type PartySummary, type PartyType, toDisplayQty, unitLabel } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis } from '../../api/hooks/me';
import { useParties } from '../../api/hooks/masters';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Avatar,
  type AvatarTone,
  Badge,
  Button,
  EmptyState,
  Group,
  Row,
  Screen,
  SearchField,
  SegmentedControl,
  Text,
  useDebouncedValue,
} from '../../ui';
import { messageFor } from '../messages';
import { BackHeader } from '../admin/parts';

export const PARTY_TYPE_LABEL: Record<PartyType, { one: string; many: string; tone: AvatarTone }> = {
  customer: { one: 'customer', many: 'Customers', tone: 'br' },
  broker: { one: 'broker', many: 'Brokers', tone: 'vi' },
  transporter: { one: 'transporter', many: 'Transporters', tone: 'te' },
};
/** More has two entries: trading partners (customers and brokers) and transporters, each its own list. */
const TRADE: PartyType[] = ['customer', 'broker'];
const TRANSPORT: PartyType[] = ['transporter'];
export const typesFor = (t: PartyType): PartyType[] => (t === 'transporter' ? TRANSPORT : TRADE);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Canvas board 18: customers, brokers and transporters shared by every company. */
export function PartiesScreen({ initialType = 'customer' }: { initialType?: PartyType }) {
  const TYPES = typesFor(initialType);
  const transporters = initialType === 'transporter';
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: companies } = useCompanies();
  const [type, setType] = useState<PartyType>(initialType);
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  // One request per search term; the type tabs filter it, so their counts come from the same answer.
  const parties = useParties(q ? { q } : {});
  // Only this list's types: a search here never surfaces the other list's parties.
  const all = useMemo(() => (parties.data ?? []).filter((p) => TYPES.includes(p.type)), [parties.data, TYPES]);
  const counts = useMemo(
    () =>
      Object.fromEntries((['customer', 'broker', 'transporter'] as const).map((x) => [x, all.filter((p) => p.type === x).length])) as Record<PartyType, number>,
    [all],
  );
  // A search that only matches another type moves to that tab, so the result is never hidden.
  const shown = counts[type] === 0 && q !== '' ? (TYPES.find((x) => counts[x] > 0) ?? type) : type;
  const list = all.filter((p) => p.type === shown);
  const companyCount = companies?.filter((c) => c.active).length ?? 0;

  return (
    <Screen
      title={transporters ? 'Transporters' : 'Customers & brokers'}
      header={<BackHeader />}
      footer={
        <Button onPress={() => router.push({ pathname: '/parties/form', params: { type: shown } })}>
          {`Add ${PARTY_TYPE_LABEL[shown].one}`}
        </Button>
      }
    >
      <Text variant="caption" style={styles.sub}>
        {companyCount > 0 ? `Shared across all ${companyCount} companies` : 'Shared across all companies'}
      </Text>
      <SearchField value={search} onChangeText={setSearch} placeholder="Name, city, GSTIN or number" label="Search parties" />
{transporters ? null : (
        <SegmentedControl
          size="full"
          accessibilityLabel="Party type"
          value={shown}
          onChange={(v: PartyType) => setType(v)}
          options={TYPES.map((x) => ({ value: x, label: `${PARTY_TYPE_LABEL[x].many} ${counts[x]}` }))}
        />
      )}
      {parties.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading parties" />
      ) : parties.isError ? (
        <View style={styles.gap}>
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(parties.error)}
          </Text>
          <Button variant="secondary" onPress={() => void parties.refetch()}>
            Try again
          </Button>
        </View>
      ) : list.length === 0 ? (
        q !== '' ? (
          <Text color="tx2" style={styles.empty}>{`No parties match “${q}”`}</Text>
        ) : (
          <EmptyState
            icon="users"
            title={`No ${PARTY_TYPE_LABEL[shown].many.toLowerCase()} yet`}
            body={
              shown === 'transporter'
                ? 'Add the transporters whose trucks load at your plants.'
                : `Add a ${PARTY_TYPE_LABEL[shown].one} to start booking orders.`
            }
          />
        )
      ) : (
        <Group>
          {list.map((p) => (
            <PartyRow key={p.id} p={p} basis={basis} onPress={() => router.push(`/parties/${p.id}`)} />
          ))}
        </Group>
      )}
    </Screen>
  );
}

function PartyRow({ p, basis, onPress }: { p: PartySummary; basis: ReturnType<typeof useDisplayBasis>; onPress(): void }) {
  const detail = [p.city, plural(p.people, 'person', 'people'), plural(p.numbers, 'number', 'numbers')].join(' · ');
  const showsPending = p.type !== 'transporter';
  const pendingText = p.pendingKg > 0 ? `${toDisplayQty(p.pendingKg, basis, { withUnit: true })} pending` : 'no pending';
  return (
    <Row
      onPress={onPress}
      accessibilityLabel={`${p.name}, ${detail}${showsPending ? `, ${pendingText}` : ''}${p.active ? '' : ', inactive'}`}
    >
      <Avatar name={p.name} tone={p.active ? PARTY_TYPE_LABEL[p.type].tone : 'nu'} />
      <View style={styles.fill}>
        <Text weight="medium" numberOfLines={1}>
          {p.name}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {!p.active ? (
        <Badge kind="nu">Inactive</Badge>
      ) : showsPending ? (
        <View style={styles.right}>
          <Text weight="semibold" numeric>
            {p.pendingKg > 0 ? toDisplayQty(p.pendingKg, basis) : 'Clear'}
          </Text>
          <Text variant="caption">{p.pendingKg > 0 ? `${unitLabel(basis)} pending` : 'no pending'}</Text>
        </View>
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: -12 },
  gap: { gap: 12 },
  fill: { flex: 1, minWidth: 0 },
  right: { alignItems: 'flex-end' },
  empty: { textAlign: 'center', paddingVertical: 24 },
});
