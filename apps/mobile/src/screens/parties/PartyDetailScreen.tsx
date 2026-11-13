import { type Party, formatMobile, toDisplayQty } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { useParty } from '../../api/hooks/masters';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Avatar,
  Badge,
  EmptyState,
  Group,
  Icon,
  type IconName,
  IconButton,
  Row,
  Screen,
  SectionLabel,
  showToast,
  Text,
} from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader } from '../admin/parts';
import { PARTY_TYPE_LABEL } from './PartiesScreen';

const isMobile = (n: string) => /^\+91[6-9]\d{9}$/.test(n);

async function open(url: string, fallback: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    showToast(fallback);
  }
}
const call = (n: string) => void open(`tel:${n}`, "Couldn't start a call on this phone");
const whatsapp = (n: string) => void open(`https://wa.me/${n.replace(/\D/g, '')}`, "Couldn't open WhatsApp");

/** Canvas boards 05 (customer / broker) and 20 (transporter). */
export function PartyDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const { t } = useTheme();
  const party = useParty(id);

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
  const first = p.contacts.flatMap((c) => c.numbers)[0];
  const firstWa = p.contacts.flatMap((c) => c.numbers).find((n) => n.whatsapp);

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

      {p.type !== 'transporter' ? <Stats p={p} /> : null}

      <SectionLabel>Contacts</SectionLabel>
      <Group>
        {p.contacts.length === 0 ? (
          <Row>
            <Text color="tx2">No contacts yet</Text>
          </Row>
        ) : null}
        {p.contacts.map((c) => (
          <View key={c.id}>
            <Row>
              <Text weight="semibold" style={styles.fill}>
                {c.name}
              </Text>
              {c.roleLabel ? <Text variant="caption">{c.roleLabel}</Text> : null}
            </Row>
            {c.numbers.map((n) => {
              const shown = formatMobile(n.number);
              return (
                <Row key={n.id}>
                  <View style={styles.fill}>
                    <Text numeric>{shown}</Text>
                    <Text variant="caption">
                      {[n.label || (isMobile(n.number) ? 'Mobile' : 'Phone'), n.whatsapp ? 'gets WhatsApp updates' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <IconButton icon="phone" label={`Call ${shown}`} onPress={() => call(n.number)} />
                  {n.whatsapp ? <IconButton icon="message" label={`WhatsApp ${shown}`} onPress={() => whatsapp(n.number)} /> : null}
                </Row>
              );
            })}
          </View>
        ))}
      </Group>

      {p.type === 'customer' ? <Addresses p={p} /> : null}
    </Screen>
  );
}

function Action({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress(): void; disabled?: boolean }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Icon name={icon} size={20} color={t.brt} />
      <Text weight="medium" variant="caption" color="tx">
        {label}
      </Text>
    </Pressable>
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
  action: {
    flex: 1,
    minHeight: 64,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  stats: { flexDirection: 'row', padding: 16, gap: 12 },
  tile: { flex: 1, gap: 2 },
});
