import { type Truck, can, toDisplayQty } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useTruck } from '../../api/hooks/trucks';
import { istClock } from '../../format/time';
import { useDeviceSnapshot } from '../../offline/useDeviceData';
import { useTheme } from '../../theme/ThemeProvider';
import { type Tokens } from '../../theme/tokens';
import { Badge, Button, EmptyState, Group, IconButton, Row, Screen, showToast, Text, UnitTag } from '../../ui';
import { BackHeader } from '../admin/parts';
import { MSG, messageFor } from '../messages';
import { ApproveSheet } from './ApproveSheet';
import { CancelTruckSheet } from './CancelTruckSheet';
import { CorrectWeightSheet } from './CorrectWeightSheet';
import { SupervisorCard } from './SupervisorCard';
import { Progress, Weighments } from './TruckTimeline';
import { TRUCK_STATE_META, isOpenState, planLabel, shownPhone } from './truckStateMeta';

const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** Canvas board 09: one truck, its weights, plan, progress, people and the actions this role has. */
export function TruckDetailScreen({ id }: { id: string }) {
  const { t } = useTheme();
  const truck = useTruck(id);
  if (!truck.data) {
    return (
      <Screen header={<BackHeader />}>
        {truck.isPending ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="truck"
            title="Not found"
            body={truck.isError ? messageFor(truck.error) : MSG.notFound}
            actions={truck.isError ? [{ label: 'Try again', onPress: () => void truck.refetch() }] : []}
          />
        )}
      </Screen>
    );
  }
  return <Detail x={truck.data} refreshing={truck.isRefetching} refetch={() => void truck.refetch()} />;
}

function Detail({ x, refreshing, refetch }: { x: Truck; refreshing: boolean; refetch(): void }) {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const snap = useDeviceSnapshot();
  const [cancelling, setCancelling] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [approving, setApproving] = useState(false);
  const role = me?.role;
  const may = (a: Parameters<typeof can>[1]) => (role ? can(role, a) : false);
  const all = byCode(companies ?? []);
  const company = all.find((c) => c.id === x.companyId);
  const meta = TRUCK_STATE_META[x.state];
  const open = isOpenState(x.state);
  const q = (kg: number) => toDisplayQty(kg, basis);
  const planned = x.plan.reduce((s, p) => s + p.plannedKg, 0);
  // Owner weighs on this phone (Ruling 4); an unsent weight shows until the server has it.
  const unsent = (snap?.outbox ?? []).filter((r) => r.truckId === x.id && (r.status === 'pending' || r.status === 'sending'));

  const canEdit = may('truck.edit') && x.state !== 'cancelled';
  const canCancel = may('truck.cancel') && open;
  const awaiting = x.state === 'weighed';
  // Weighing is for trucks the phone still has work on; a weighed truck waits for the office.
  const canWeigh = role === 'owner' && may('weighment.capture') && open && !awaiting && unsent.length === 0;
  // TON-57: owner and city staff change weights awaiting approval and after dispatch.
  const canCorrect = may('weighment.correct') && (awaiting || x.state === 'dispatched');
  const canApprove = may('dispatch.approve') && awaiting;
  const edit = () =>
    router.push({ pathname: '/assign/[subOrderId]', params: { subOrderId: x.subOrderId, orderId: x.orderId, truckId: x.id } });
  const call = async () => {
    try {
      await Linking.openURL(`tel:${x.driverPhone}`);
    } catch {
      showToast("Couldn't start a call on this phone");
    }
  };

  const footer =
    canWeigh || canEdit || canCancel || canCorrect || canApprove ? (
      <>
        {canApprove ? <Button onPress={() => setApproving(true)}>Approve dispatch</Button> : null}
        {canWeigh ? (
          <Button variant={x.state === 'loading' ? 'primary' : 'violet'} onPress={() => router.push(`/weigh/${x.id}`)}>
            {x.state === 'loading' ? 'Capture gross weight' : 'Capture tare weight'}
          </Button>
        ) : null}
        <View style={styles.buttons}>
          {canCancel ? (
            <Button variant="secondary" onPress={() => setCancelling(true)}>
              Cancel truck
            </Button>
          ) : null}
          {canCorrect ? (
            <Button variant="secondary" onPress={() => setCorrecting(true)}>
              {awaiting ? 'Change weights' : 'Correct weight'}
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant={canWeigh || canApprove ? 'secondary' : 'primary'} onPress={edit} style={styles.fill}>
              {x.state === 'dispatched' ? 'Edit LR' : 'Edit vehicle / LR'}
            </Button>
          ) : null}
        </View>
      </>
    ) : undefined;

  return (
    <Screen
      header={<BackHeader right={canEdit ? <IconButton icon="pencil" label="Edit vehicle details" onPress={edit} /> : undefined} />}
      refresh={{ refreshing, onRefresh: refetch }}
      footer={footer}
    >
      <View style={styles.head}>
        <View style={styles.inline}>
          <Badge kind={meta.kind} dot>
            {meta.label}
          </Badge>
          <UnitTag code={x.companyCode} slot={Math.max(0, all.findIndex((c) => c.id === x.companyId))} />
        </View>
        <Text variant="title" accessibilityRole="header">
          {x.vehicleNo}
        </Text>
        <Text variant="caption" style={styles.sub}>
          {`${company?.name ?? x.companyCode} · ${x.plantName} · assigned by ${first(x.assignedBy.name)} at ${istClock(x.assignedAt)}`}
        </Text>
        {x.state === 'cancelled' && x.cancelReason ? (
          <Text variant="caption" color="dgt">{`Cancelled · ${x.cancelReason}`}</Text>
        ) : null}
      </View>

      {awaiting ? (
        <View style={[styles.note, { backgroundColor: t.vis }]} accessibilityLiveRegion="polite">
          <Text color="vi" style={styles.small}>
            {`Weighed at ${x.plantName}${x.weighedAt ? ` at ${istClock(x.weighedAt)}` : ''} · ${canApprove ? 'check the weights and approve the dispatch' : 'waiting for the office to approve'}`}
          </Text>
        </View>
      ) : null}

      {unsent.length > 0 ? (
        <View style={[styles.note, { backgroundColor: t.wns }]} accessibilityLiveRegion="polite">
          <Text color="wnt" style={styles.small}>
            Weight saved on this phone · sending
          </Text>
        </View>
      ) : null}

      <Group>
        <View style={styles.card}>
          <Text variant="overline">Weighment</Text>
          <View style={styles.tiles}>
            <WeightTile label="Tare" kg={x.tareKg} at={x.tareAt} empty="waiting" bg="brs" fg="brt" />
            <WeightTile label="Gross" kg={x.grossKg} at={x.weighedAt ?? x.dispatchedAt} empty={x.tareKg === null ? 'after tare' : 'waiting'} bg="wns" fg="wnt" />
            <WeightTile label="Net" kg={x.netKg} at={null} empty="after gross" bg="oks" fg="okt" />
          </View>
          <View style={[styles.kv, styles.rule, { borderTopColor: t.bd }]}>
            <Text color="tx2" style={styles.fill}>
              Planned load
            </Text>
            <Text weight="semibold" numeric>
              {toDisplayQty(planned, basis, { withUnit: true })}
            </Text>
          </View>
          {x.loadingSlipNo ? (
            <View style={styles.kv}>
              <Text color="tx2" style={styles.fill}>
                Loading slip
              </Text>
              <Text weight="semibold">{x.loadingSlipNo}</Text>
            </View>
          ) : null}
        </View>
      </Group>

      <Text variant="heading">What to load</Text>
      <Group>
        {x.plan.map((p) => {
          const net = x.allocations.find((a) => a.orderLineId === p.orderLineId)?.netKg;
          return (
            <Row key={p.orderLineId}>
              <View style={styles.fill}>
                <Text weight="medium">{planLabel(p)}</Text>
                <Text variant="caption">
                  {net === undefined ? `Plan ${q(p.plannedKg)}` : `Plan ${q(p.plannedKg)} · loaded ${q(net)}`}
                </Text>
              </View>
              <Text weight="semibold" numeric>
                {q(net ?? p.plannedKg)}
              </Text>
            </Row>
          );
        })}
      </Group>

      <Progress x={x} />
      <Weighments x={x} />

      <SupervisorCard truck={x} />

      <Text variant="heading">Driver & transporter</Text>
      <Group>
        <Row>
          <View style={styles.fill}>
            <Text weight="medium">{x.driverName}</Text>
            <Text variant="caption">{`Driver · ${shownPhone(x.driverPhone)}`}</Text>
          </View>
          <IconButton icon="phone" label={`Call driver ${x.driverName}`} onPress={() => void call()} />
        </Row>
        {x.transporter ? (
          <Row onPress={() => router.push(`/parties/${x.transporter!.id}`)} accessibilityLabel={`Transporter, ${x.transporter.name}`}>
            <View style={styles.fill}>
              <Text weight="medium">{x.transporter.name}</Text>
              <Text variant="caption">Transporter</Text>
            </View>
          </Row>
        ) : (
          <Row>
            <View style={styles.fill}>
              <Text weight="medium">Self</Text>
              <Text variant="caption">Transporter · own vehicle</Text>
            </View>
          </Row>
        )}
        <Row onPress={canEdit ? edit : undefined} accessibilityLabel={`LR number, ${x.lrNo ?? 'not added yet'}`}>
          <View style={styles.fill}>
            <Text weight="medium">LR number</Text>
            <Text variant="caption" color={x.lrNo ? 'tx3' : 'wnt'}>
              {x.lrNo ?? 'Not added yet'}
            </Text>
          </View>
          {canEdit ? (
            <Text weight="medium" color="brt" style={styles.small}>
              {x.lrNo ? 'Edit LR' : 'Add LR'}
            </Text>
          ) : null}
        </Row>
      </Group>

      <Text variant="heading">Order</Text>
      <Group>
        <Row onPress={() => router.push(`/orders/${x.orderId}`)} accessibilityLabel={`Order ${x.subOrderNumber}, ${x.customerName ?? 'customer not added yet'}`}>
          <View style={styles.fill}>
            <Text weight="medium">{x.subOrderNumber}</Text>
            <Text variant="caption">{x.customerName ?? 'Customer not added yet'}</Text>
          </View>
        </Row>
      </Group>

      <CancelTruckSheet truck={x} visible={cancelling} onClose={() => setCancelling(false)} />
      {canCorrect || correcting ? (
        <CorrectWeightSheet truck={x} visible={correcting} onClose={() => setCorrecting(false)} />
      ) : null}
      {canApprove || approving ? (
        <ApproveSheet
          truck={x}
          visible={approving}
          onClose={() => setApproving(false)}
          onChangeWeights={canCorrect ? () => setCorrecting(true) : undefined}
        />
      ) : null}
    </Screen>
  );
}

function WeightTile({
  label,
  kg,
  at,
  empty,
  bg,
  fg,
}: {
  label: string;
  kg: number | null;
  at: string | null;
  empty: string;
  bg: keyof Tokens;
  fg: keyof Tokens;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const shown = kg === null ? '—' : toDisplayQty(kg, basis);
  return (
    <View
      style={[styles.tile, { backgroundColor: kg === null ? t.ctl : t[bg] }]}
      accessible
      accessibilityLabel={kg === null ? `${label}, ${empty}` : `${label}, ${toDisplayQty(kg, basis, { withUnit: true })}`}
    >
      <Text variant="caption" color={kg === null ? 'tx3' : fg}>
        {label}
      </Text>
      <Text weight="semibold" numeric color={kg === null ? 'tx3' : fg} style={styles.weight}>
        {shown}
      </Text>
      <Text variant="caption">{kg === null ? empty : at ? istClock(at) : ' '}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sub: { fontSize: 13, lineHeight: 18 },
  fill: { flex: 1, minWidth: 0 },
  small: { fontSize: 13, lineHeight: 18 },
  note: { padding: 12, borderRadius: 12 },
  card: { padding: 16, gap: 12 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, padding: 14, borderRadius: 14, gap: 2 },
  weight: { fontSize: 18, lineHeight: 24 },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rule: { paddingTop: 12, borderTopWidth: 1 },
  buttons: { flexDirection: 'row', gap: 10 },
});
