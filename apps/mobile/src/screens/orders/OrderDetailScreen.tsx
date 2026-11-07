import {
  type Order,
  type SubOrder,
  can,
  formatLength,
  formatRupeesShort,
  isTerminal,
  toDisplayQty,
  toDisplayRate,
  unitLabel,
} from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useDraftApi, useOrder, useReopen } from '../../api/hooks/orders';
import { useTenantSettings } from '../../api/hooks/settings';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { relativeTime } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, Button, EmptyState, Group, IconButton, ProgressBar, Row, Screen, showToast, Text, UnitTag } from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader } from '../admin/parts';
import { ActivitySheet } from './ActivitySheet';
import { DeleteOrderSheet } from './DeleteOrderSheet';
import { MoveQuantitySheet } from './MoveQuantitySheet';
import { type OrderAction, OrderActionsSheet } from './OrderActionsSheet';
import { shareText } from './shareText';
import { ShortCloseSheet, truckLine } from './ShortCloseSheet';
import { statusMeta } from './statusMeta';

type SheetName = 'actions' | 'shortClose' | 'delete' | 'move' | 'activity' | null;

/** Canvas board 04: one order, its sub-orders per company, lines, open trucks and actions. */
export function OrderDetailScreen({ id }: { id: string }) {
  const { t } = useTheme();
  const order = useOrder(id);
  if (!order.data) {
    return (
      <Screen header={<BackHeader />}>
        {order.isPending ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="orders"
            title="Not found"
            body={order.isError ? messageFor(order.error) : MSG.notFound}
            actions={order.isError ? [{ label: 'Try again', onPress: () => void order.refetch() }] : []}
          />
        )}
      </Screen>
    );
  }
  return <Detail o={order.data} refetch={() => void order.refetch()} refreshing={order.isRefetching} />;
}

function Detail({ o, refetch, refreshing }: { o: Order; refetch(): void; refreshing: boolean }) {
  const router = useRouter();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: settings } = useTenantSettings();
  const { data: companies } = useCompanies();
  const drafts = useDraftApi();
  const dupKey = useSubmitKey();
  const once = useSingleFlight();
  const [sheet, setSheet] = useState<SheetName>(null);
  const role = me?.role;
  const may = (a: Parameters<typeof can>[1]) => (role ? can(role, a) : false);
  const all = byCode(companies ?? []);
  const slot = (code: string) => Math.max(0, all.findIndex((c) => c.code === code));
  const unit = unitLabel(basis);
  const q = (kg: number) => toDisplayQty(kg, basis);
  const open = o.subOrders.filter((s) => !isTerminal(s.status));
  const openTrucks = o.subOrders.flatMap((s) => s.openTrucks);
  const dispatchedTrucks = o.subOrders.reduce((n, s) => n + s.dispatchedTrucks, 0);
  const meta = statusMeta(o.status);
  const now = Date.now();

  const share = async () => {
    const text = shareText(o, settings?.externalUnitBasis ?? 'mt');
    try {
      await Linking.openURL(`https://wa.me/?text=${encodeURIComponent(text)}`);
    } catch {
      showToast("Couldn't open WhatsApp");
    }
  };

  const duplicate = async () => {
    try {
      const d = await drafts.duplicate(o.id, dupKey.key());
      dupKey.settle();
      router.push({ pathname: '/order-form', params: { draftId: d.id } });
    } catch (e) {
      dupKey.settle(e);
      showToast(messageFor(e));
    }
  };

  const actions: OrderAction[] = [
    ...(may('order.edit') && open.length > 0
      ? [{ key: 'edit', icon: 'pencil' as const, title: 'Edit order', detail: 'Lines, rates, broker, ship-to', onPress: () => router.push({ pathname: '/order-form', params: { orderId: o.id } }) }]
      : []),
    ...(may('truck.assign') && open.length > 0
      ? [{ key: 'assign', icon: 'truck' as const, title: 'Assign vehicle', detail: 'Send a truck to a plant', onPress: () => showToast('Assigning vehicles arrives in the next update') }]
      : []),
    ...(may('order.edit') && open.length > 0 && o.subOrders.length > 0
      ? [{ key: 'move', icon: 'sliders' as const, title: 'Move quantity', detail: 'Undispatched quantity to another company', onPress: () => setSheet('move') }]
      : []),
    ...(may('order.duplicate')
      ? [{ key: 'dup', icon: 'plus' as const, title: 'Duplicate order', detail: 'Start a new draft with the same lines', onPress: () => void once(duplicate) }]
      : []),
    { key: 'share', icon: 'share', title: 'Share on WhatsApp', detail: 'Order summary with pending quantity', onPress: () => void share() },
    { key: 'activity', icon: 'info', title: 'Activity history', detail: 'Who changed what, and when', onPress: () => setSheet('activity') },
    ...(may('order.shortClose') && open.length > 0
      ? [{ key: 'close', icon: 'close' as const, title: 'Short close', detail: `Stop the remaining ${q(o.totals.pendingKg)} ${unit}`, onPress: () => setSheet('shortClose') }]
      : []),
    ...(may('order.hardDelete')
      ? [{ key: 'delete', icon: 'trash' as const, title: 'Delete forever', detail: 'Owner only · removes every record', danger: true, onPress: () => setSheet('delete') }]
      : []),
  ];
  // Plant heads only read: the menu would hold nothing but share and history.
  const showMenu = may('order.edit') || may('order.hardDelete') || may('order.shortClose');

  const who = o.customer?.name ?? 'Customer not added yet';
  const kind =
    o.type === 'broker_only' ? `Broker order · ${o.broker?.name ?? ''}` : o.broker ? `Via ${o.broker.name}` : 'Direct order';
  const shipTo = o.shipTo ? ` · Ship to ${o.shipTo.label}, ${o.shipTo.address}` : '';
  // Canvas "3 + 1 loading"; "open" when some of them are not loading yet.
  const openWord = openTrucks.every((x) => x.state === 'loading') ? 'loading' : 'open';
  const trucksText = `${dispatchedTrucks}${openTrucks.length > 0 ? ` + ${openTrucks.length} ${openWord}` : ''}`;

  return (
    <Screen
      header={
        <BackHeader
          right={
            <>
              <IconButton icon="share" label="Share on WhatsApp" onPress={() => void share()} />
              {showMenu ? <IconButton icon="more" label="More actions" onPress={() => setSheet('actions')} /> : null}
            </>
          }
        />
      }
      refresh={{ refreshing, onRefresh: refetch }}
      footer={
        may('order.shortClose') && open.length > 0 ? (
          <View style={styles.footer}>
            <Button variant="secondary" onPress={() => setSheet('shortClose')}>
              Short close
            </Button>
            <Button onPress={() => showToast('Assigning vehicles arrives in the next update')} style={styles.fill}>
              Assign vehicle
            </Button>
          </View>
        ) : undefined
      }
    >
      <View style={styles.head}>
        <View style={styles.inline}>
          <Badge kind={meta.kind} dot>
            {meta.label}
          </Badge>
          <Text variant="caption" style={styles.fill} numberOfLines={1}>{`${o.number} · ${relativeTime(o.createdAt, now)} · ${o.createdBy.name}`}</Text>
        </View>
        <Text variant="subtitle" weight="semibold" accessibilityRole="header" color={o.customer ? 'tx' : 'wnt'}>
          {who}
        </Text>
        <Text variant="caption">{`${kind}${shipTo}`}</Text>
      </View>

      <Group>
        <View style={styles.card}>
          <Text variant="overline">Dispatched</Text>
          <View style={styles.baseline} accessible accessibilityLabel={`Dispatched ${q(o.totals.dispatchedKg)} of ${q(o.totals.orderedKg)} ${unit}`}>
            <Text numeric weight="semibold" color="okt" style={styles.big}>
              {q(o.totals.dispatchedKg)}
            </Text>
            <Text weight="medium" color="tx2">{`/ ${q(o.totals.orderedKg)} ${unit}`}</Text>
          </View>
          <ProgressBar value={o.totals.orderedKg > 0 ? o.totals.dispatchedKg / o.totals.orderedKg : 0} height={6} />
          <View style={styles.stats}>
            <Stat label="Pending" value={`${q(o.totals.pendingKg)} ${unit}`} color="wnt" />
            <Stat label="Trucks" value={trucksText} />
            {o.estimatedValue !== undefined ? <Stat label="Value" value={formatRupeesShort(o.estimatedValue)} /> : null}
          </View>
        </View>
      </Group>

      {o.subOrders.map((s) => (
        <SubOrderSection key={s.id} o={o} s={s} slot={slot(s.companyCode)} canReopen={may('order.reopen')} />
      ))}

      {openTrucks.length > 0 || dispatchedTrucks > 0 ? (
        <>
          <Text variant="heading">Trucks</Text>
          <Group>
            {o.subOrders.flatMap((s) =>
              s.openTrucks.map((x) => (
                <Row key={x.id} accessibilityLabel={truckLine(x, basis).replace(' — ', ', ')}>
                  <View style={styles.fill}>
                    <Text weight="medium">{x.vehicleNo}</Text>
                    <Text variant="caption">{`${s.companyCode} · sub-order ${s.suffix}${x.tareKg !== null ? ` · tare ${toDisplayQty(x.tareKg, basis, { withUnit: true })}` : ''}`}</Text>
                  </View>
                  <Badge kind={x.state === 'loading' ? 'wn' : 'br'} dot>
                    {x.state === 'loading' ? 'Loading' : x.state === 'at_gate' ? 'At gate' : 'Assigned'}
                  </Badge>
                </Row>
              )),
            )}
            {dispatchedTrucks > 0 ? (
              <Row>
                <Text color="tx2" style={styles.fill}>{`${dispatchedTrucks} ${dispatchedTrucks === 1 ? 'truck' : 'trucks'} dispatched · ${q(o.totals.dispatchedKg)} ${unit} net`}</Text>
              </Row>
            ) : null}
          </Group>
        </>
      ) : null}

      <OrderActionsSheet
        visible={sheet === 'actions'}
        title={o.number}
        subtitle={`${who} · ${q(o.totals.pendingKg)} ${unit} pending`}
        actions={actions}
        onClose={() => setSheet((x) => (x === 'actions' ? null : x))}
      />
      <ShortCloseSheet order={o} visible={sheet === 'shortClose'} onClose={() => setSheet(null)} />
      <DeleteOrderSheet
        order={o}
        visible={sheet === 'delete'}
        onClose={() => setSheet(null)}
        onDeleted={() => {
          setSheet(null);
          showToast(`${o.number} deleted`);
          router.back();
        }}
      />
      <MoveQuantitySheet order={o} visible={sheet === 'move'} onClose={() => setSheet(null)} />
      <ActivitySheet orderId={o.id} visible={sheet === 'activity'} onClose={() => setSheet(null)} />
    </Screen>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: 'wnt' }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text variant="caption">{label}</Text>
      <Text weight="semibold" numeric color={color ?? 'tx'}>
        {value}
      </Text>
    </View>
  );
}

function SubOrderSection({ o, s, slot, canReopen }: { o: Order; s: SubOrder; slot: number; canReopen: boolean }) {
  const basis = useDisplayBasis();
  const reopen = useReopen();
  const once = useSingleFlight();
  const unit = unitLabel(basis);
  const q = (kg: number) => toDisplayQty(kg, basis);
  const closed = s.closeKind !== null;
  const closedLabel = s.closeKind === 'cancel' ? 'Cancelled' : s.closeKind === 'tolerance' ? 'Completed within tolerance' : 'Short closed';
  return (
    <View style={styles.section}>
      <View style={styles.inline}>
        <Text variant="heading" style={styles.fill} numberOfLines={1}>
          {s.companyName}
        </Text>
        <UnitTag code={s.companyCode} slot={slot} />
        <Text variant="caption">{`Sub-order ${s.suffix}`}</Text>
      </View>
      {closed ? (
        <Group>
          <Row>
            <View style={styles.fill}>
              <Text weight="medium">{[closedLabel, s.closeReason, s.closedAt ? relativeTime(s.closedAt, Date.now()) : null].filter(Boolean).join(' · ')}</Text>
              {s.closeNote ? <Text variant="caption">{s.closeNote}</Text> : null}
            </View>
            {canReopen && s.closeKind !== 'tolerance' ? (
              <Button
                variant="secondary"
                loading={reopen.isPending}
                onPress={() =>
                  void once(async () => {
                    try {
                      await reopen.mutateAsync({ subOrderId: s.id, version: s.version });
                      showToast(`${s.number} reopened`);
                    } catch (e) {
                      showToast(messageFor(e));
                    }
                  })
                }
              >
                Reopen
              </Button>
            ) : null}
          </Row>
        </Group>
      ) : null}
      <Group>
        {s.lines.map((l) => (
          <View key={l.id} style={styles.line}>
            <View style={styles.inline}>
              <Text weight="medium" style={styles.fill} numberOfLines={2}>{`${l.productName} · ${formatLength(l.length)}`}</Text>
              {l.rate !== undefined ? <Text variant="caption" numeric>{toDisplayRate(l.rate, basis)}</Text> : null}
              {l.rateEdited && l.rate !== undefined ? <Badge kind="nu">Edited</Badge> : null}
            </View>
            <ProgressBar value={l.orderedKg > 0 ? l.dispatchedKg / l.orderedKg : 0} tone={closed ? 'muted' : 'bar'} />
            <Text variant="caption">
              {`${q(l.dispatchedKg)} of ${q(l.orderedKg)} ${unit}`}
              {l.pendingKg > 0 ? ` · ${q(l.pendingKg)} pending` : ''}
              {l.closedKg > 0 ? ` · ${q(l.closedKg)} closed` : ''}
              {l.overKg > 0 ? ` · +${q(l.overKg)} over` : ''}
            </Text>
          </View>
        ))}
      </Group>
      {o.type === 'broker_only' && !o.customer ? (
        <Text variant="caption" color="wnt">
          Add the customer before trucks can be assigned.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 6 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  card: { padding: 20, gap: 14 },
  baseline: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  big: { fontSize: 32, lineHeight: 36 },
  stats: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1, gap: 2 },
  section: { gap: 10 },
  line: { padding: 16, gap: 8 },
  footer: { flexDirection: 'row', gap: 10 },
});
