import { type Party, can, toDisplayQty } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useParty } from '../../api/hooks/masters';
import { useTheme } from '../../theme/ThemeProvider';
import { Avatar, Badge, EmptyState, Group, IconButton, Row, Screen, SectionLabel, Text } from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader } from '../admin/parts';
import { BrokerProfileScreen } from '../money/BrokerProfileScreen';
import { PARTY_TYPE_LABEL } from './PartiesScreen';
import { Action, Contacts, call, firstNumbers, whatsapp } from './partyParts';

/** Canvas boards 05 (customer / broker) and 20 (transporter). */
export function PartyDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const { t } = useTheme();
  const party = useParty(id);
  const { data: me } = useMe();

  if (!party.data) {
    return (
      <Screen header={<BackHeader />}>
        {party.isPending ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="users"
            title="Not found"
            body={party.isError ? messageFor(party.error) : MSG.notFound}
            actions={party.isError ? [{ label: 'Try again', onPress: () => void party.refetch() }] : []}
          />
        )}
      </Screen>
    );
  }
  const p = party.data;
  // Ruling 8: for money roles a broker's page is board 06, the profile with the ledger.
  if (p.type === 'broker' && me && can(me.role, 'money.view')) return <BrokerProfileScreen party={p} />;
  const { first, firstWa } = firstNumbers(p);

  return (
    <Screen
      header={
        <BackHeader
          right={<IconButton icon="pencil" label="Edit party" onPress={() => router.push({ pathname: '/parties/form', params: { id: p.id } })} />}
        />
      }
    >
      <View style={styles.head}>
        <Avatar name={p.name} tone={p.active ? PARTY_TYPE_LABEL[p.type].tone : 'nu'} size={56} />
        <View style={styles.fill}>
          <Text variant="subtitle" weight="semibold" accessibilityRole="header">
            {p.name}
          </Text>
          <View style={styles.inline}>
            <Badge kind={p.type === 'customer' ? 'br' : p.type === 'broker' ? 'vi' : 'te'}>
              {PARTY_TYPE_LABEL[p.type].one.replace(/^./, (c) => c.toUpperCase())}
            </Badge>
            {!p.active ? <Badge kind="nu">Inactive</Badge> : null}
            <Text variant="caption" style={styles.fill} numberOfLines={2}>
              {[p.city, p.gstin ? `GSTIN ${p.gstin}` : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.actions}>
        <Action icon="phone" label="Call" disabled={!first} onPress={() => first && call(first.number)} />
        <Action icon="message" label="WhatsApp" disabled={!firstWa} onPress={() => firstWa && whatsapp(firstWa.number)} />
        {p.type !== 'transporter' ? (
          <Action icon="plus" label="New order" onPress={() => router.push({ pathname: '/order-form', params: { partyId: p.id } })} />
        ) : null}
      </View>

      {p.type !== 'transporter' ? <Stats p={p} /> : <TransporterStats p={p} />}

      <Contacts p={p} />

      {p.type === 'customer' ? <Addresses p={p} /> : null}
      {p.type === 'transporter' && (p.stats.recentVehicles ?? []).length > 0 ? (
        <>
          <SectionLabel>Recent vehicles</SectionLabel>
          <Group>
            {(p.stats.recentVehicles ?? []).map((v) => (
              <Row key={v}>
                <Text weight="medium">{v}</Text>
              </Row>
            ))}
          </Group>
        </>
      ) : null}
    </Screen>
  );
}

function Stats({ p }: { p: Party }) {
  const basis = useDisplayBasis();
  const tile = (label: string, value: string) => (
    <View style={styles.tile}>
      <Text variant="caption">{label}</Text>
      <Text weight="semibold" numeric>
        {value}
      </Text>
    </View>
  );
  return (
    <Group>
      <View style={styles.stats}>
        {tile('Open orders', String(p.stats.openOrders))}
        {tile('Pending', toDisplayQty(p.stats.pendingKg, basis, { withUnit: true }))}
        {tile('This year', toDisplayQty(p.stats.fyDispatchedKg, basis, { withUnit: true }))}
      </View>
    </Group>
  );
}

/** Canvas 20: trucks this transporter took out this month (IST) and distinct vehicles seen. */
function TransporterStats({ p }: { p: Party }) {
  const tile = (label: string, value: number) => (
    <View style={styles.tile} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text variant="caption">{label}</Text>
      <Text weight="semibold" numeric style={styles.big}>
        {String(value)}
      </Text>
    </View>
  );
  return (
    <Group>
      <View style={styles.stats}>
        {tile('Trips this month', p.stats.tripsThisMonth ?? 0)}
        {tile('Vehicles seen', p.stats.vehiclesSeen ?? 0)}
      </View>
    </Group>
  );
}

function Addresses({ p }: { p: Party }) {
  const bill = p.addresses.find((a) => a.kind === 'bill_to');
  const ship = p.addresses.filter((a) => a.kind === 'ship_to').sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return (
    <>
      <SectionLabel>Addresses</SectionLabel>
      <Group>
        <Row>
          <View style={styles.fill}>
            <Text variant="caption">Bill to</Text>
            <Text>{bill?.address ?? 'Not added'}</Text>
          </View>
        </Row>
        {ship.map((a) => (
          <Row key={a.id}>
            <View style={styles.fill}>
              <Text variant="caption">{a.isDefault ? `Ship to · ${a.label} · default` : `Ship to · ${a.label}`}</Text>
              <Text>{a.address}</Text>
            </View>
          </Row>
        ))}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  fill: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', gap: 10 },
  stats: { flexDirection: 'row', padding: 16, gap: 12 },
  tile: { flex: 1, gap: 2 },
  big: { fontSize: 20, lineHeight: 26 },
});
