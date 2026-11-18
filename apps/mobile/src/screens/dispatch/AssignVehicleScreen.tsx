import { type Order, type SubOrder, type Truck, can, isTerminal } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useOrder } from '../../api/hooks/orders';
import { usePlants } from '../../api/hooks/plants';
import { useAssignTruck, useEditTruck, useRecentVehicles, useTruck } from '../../api/hooks/trucks';
import { useParties } from '../../api/hooks/masters';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, ChoiceRow, EmptyState, Group, Icon, IconButton, Screen, showToast, Text, TextField } from '../../ui';
import { BackHeader } from '../admin/parts';
import { MSG, messageFor } from '../messages';
import { LoadPlan, RecentChip, TransporterField, TransporterPickerSheet } from './AssignParts';
import { type AssignForm, NO_CUSTOMER, check, editBody, failure, initialForm } from './assignForm';

export { NO_CUSTOMER };
import { CancelTruckSheet } from './CancelTruckSheet';
import { isOpenState, phoneForInput } from './truckStateMeta';

/** Canvas 07 (assign) and 34 (edit, with `truckId`): one truck for one sub-order. */
export function AssignVehicleScreen({ orderId, subOrderId, truckId }: { orderId: string; subOrderId: string; truckId?: string }) {
  const { t } = useTheme();
  const order = useOrder(orderId);
  const truck = useTruck(truckId);
  const sub = order.data?.subOrders.find((s) => s.id === subOrderId);
  const failed = order.isError || truck.isError;
  if (!order.data || !sub || (truckId !== undefined && !truck.data)) {
    return (
      <Screen header={<BackHeader />}>
        {(order.isPending || (truckId !== undefined && truck.isPending)) && !failed ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="truck"
            title="Not found"
            body={failed ? messageFor(order.error ?? truck.error) : MSG.notFound}
            actions={failed ? [{ label: 'Try again', onPress: () => void Promise.all([order.refetch(), truck.refetch()]) }] : []}
          />
        )}
      </Screen>
    );
  }
  // Seeded once per truck: a refetch (a synced tare, STALE, focus) never wipes what was typed.
  return <Form key={truckId ?? 'new'} o={order.data} sub={sub} latest={truck.data} />;
}

/**
 * `latest` is the server's truck as the cache has it now; `truck` is the copy the form was seeded
 * from, whose version the save sends. When the server moves on, a banner offers to reload.
 */
function Form({ o, sub, latest }: { o: Order; sub: SubOrder; latest?: Truck }) {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  const recent = useRecentVehicles(latest === undefined);
  const transporters = useParties({ type: 'transporter' });
  const assign = useAssignTruck();
  const edit = useEditTruck();
  const key = useSubmitKey();
  const once = useSingleFlight();
  const [truck, setTruck] = useState<Truck | undefined>(latest);
  const [form, setForm] = useState<AssignForm>(() => initialForm(sub, basis, latest));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => setError(undefined), [form]);

  const editing = truck !== undefined;
  const dispatched = truck?.state === 'dispatched';
  const withPlan = !editing || truck.tareKg === null; // edit hides the plan once the tare exists
  const company = companies?.find((c) => c.id === sub.companyId);
  const active = (plants ?? []).filter((p) => p.companyId === sub.companyId && p.active);
  const askPlant = !editing && active.length > 1;
  const plant = (plants ?? []).find((p) => p.id === (form.plantId ?? (active.length === 1 ? active[0]!.id : truck?.plantId)));
  const noCustomer = !editing && o.customer === null;
  const closed = !editing && isTerminal(sub.status);
  const canCancel = editing && me !== undefined && can(me.role, 'truck.cancel') && isOpenState(truck.state);
  const busy = assign.isPending || edit.isPending;
  const set = (patch: Partial<AssignForm>) => setForm((f) => ({ ...f, ...patch }));
  const moved = latest !== undefined && truck !== undefined && latest.version > truck.version;
  const reload = () => {
    if (!latest) return;
    setTruck(latest);
    setForm(initialForm(sub, basis, latest));
    setErrors({});
    setError(undefined);
    key.settle(); // the form now edits the latest truck: its save is a new request
  };

  const submit = async () => {
    const ok = check(form, sub, basis, withPlan && !dispatched);
    if (!ok.ok) {
      setErrors(ok.errors);
      return;
    }
    setErrors({});
    if (askPlant && form.plantId === null) {
      setError('Choose the plant that loads this truck');
      return;
    }
    try {
      if (truck) {
        const body = editBody(form, ok, truck, withPlan);
        if (Object.keys(body).length === 1) {
          router.back(); // nothing changed: no write, no activity entry
          return;
        }
        // The key follows the body sent (version included): a changed field is a new request.
        await edit.mutateAsync({ id: truck.id, body, key: key.key(JSON.stringify(body)) });
        key.settle();
        showToast('Saved');
        router.back();
        return;
      }
      const lr = form.lrNo.trim();
      const saved = await assign.mutateAsync({
        subOrderId: sub.id,
        key: key.key(),
        body: {
          ...(form.plantId ? { plantId: form.plantId } : {}),
          vehicleNo: ok.vehicleNo,
          transporterId: form.transporter?.id ?? null,
          driverName: form.driverName.trim(),
          driverPhone: ok.driverPhone,
          lrNo: lr === '' ? null : lr,
          plan: ok.plan,
        },
      });
      key.settle();
      const notes = [
        saved.warnings?.includes('VEHICLE_BUSY') ? `${saved.vehicleNo} is on another open truck` : null,
        saved.warnings?.includes('OVER_ASSIGNABLE') ? 'planned more than is left on the order' : null,
      ].filter(Boolean);
      showToast(notes.length > 0 ? `Assigned. ${notes.join('; ')}.` : 'Assigned · plant notified');
      router.replace(`/trucks/${saved.id}`);
    } catch (e) {
      key.settle(e);
      setError(failure(e));
    }
  };

  const pickRecent = (vehicleNo: string) => {
    const r = recent.data?.find((x) => x.vehicleNo === vehicleNo);
    if (!r) return;
    const tr = r.transporterId ? transporters.data?.find((p) => p.id === r.transporterId) : undefined;
    set({
      vehicleNo: r.vehicleNo,
      transporter: tr ? { id: tr.id, name: tr.name } : null,
      driverName: r.driverName,
      driverPhone: phoneForInput(r.driverPhone),
    });
  };

  const who = o.customer?.name ?? o.broker?.name ?? '';
  const chips = (recent.data ?? []).filter((r) => r.vehicleNo !== form.vehicleNo).slice(0, 4);

  return (
    <Screen
      keyboard
      header={
        <View style={styles.head}>
          <IconButton icon="back" label={editing ? 'Back' : 'Back to order'} onPress={() => router.back()} />
          <View style={styles.fill}>
            <Text weight="medium" accessibilityRole="header" style={styles.heading}>
              {editing ? 'Edit vehicle' : 'Assign vehicle'}
            </Text>
            <Text variant="caption" numberOfLines={1}>{`${sub.number}${who ? ` · ${who}` : ''}`}</Text>
          </View>
        </View>
      }
      footer={
        <View style={styles.buttons}>
          {canCancel ? (
            <Button variant="secondary" disabled={busy} onPress={() => setCancelling(true)}>
              Cancel truck
            </Button>
          ) : null}
          <Button loading={busy} disabled={noCustomer || closed} onPress={() => void once(submit)} style={styles.fill}>
            {editing ? 'Save changes' : 'Assign · notify plant'}
          </Button>
        </View>
      }
    >
      {plant ? (
        <View style={[styles.banner, { backgroundColor: t.brs }]}>
          <Icon name="factory" size={18} color={t.brt} />
          <Text color="brt" style={[styles.fill, styles.small]}>
            <Text weight="medium" color="brt" style={styles.small}>{`Loads at ${company?.name.split(/\s+/)[0] ?? sub.companyCode} · ${plant.name}.`}</Text>
            {' The plant supervisor gets this truck as a weighing task.'}
          </Text>
        </View>
      ) : null}
      {noCustomer || closed ? (
        <Text color="wnt" accessibilityRole="alert">
          {noCustomer ? NO_CUSTOMER : 'This sub-order is closed. Reopen it to assign a vehicle.'}
        </Text>
      ) : null}
      {dispatched ? <Text color="tx2">Dispatched: only the LR number can change now.</Text> : null}
      {moved ? (
        <View style={[styles.banner, { backgroundColor: t.wns }]} accessibilityLiveRegion="polite">
          <Text color="wnt" weight="medium" style={[styles.fill, styles.small]}>
            This truck changed.
          </Text>
          <Button variant="secondary" onPress={reload} style={styles.reload}>
            Reload latest
          </Button>
        </View>
      ) : null}

      {askPlant ? (
        <Group>
          {active.map((p) => (
            <ChoiceRow key={p.id} kind="radio" title={p.name} detail={p.location} checked={form.plantId === p.id} onPress={() => set({ plantId: p.id })} />
          ))}
        </Group>
      ) : null}

      <View style={styles.gap}>
        <TextField
          label="Vehicle number"
          value={form.vehicleNo}
          onChangeText={(v) => set({ vehicleNo: v.toUpperCase() })}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={15}
          editable={!dispatched}
          placeholder="CG 04 MK 2291"
          error={errors.vehicleNo}
        />
        {chips.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Text variant="caption" style={styles.recent}>
              Recent
            </Text>
            {chips.map((r) => (
              <RecentChip key={r.vehicleNo} vehicleNo={r.vehicleNo} onPress={() => pickRecent(r.vehicleNo)} />
            ))}
          </ScrollView>
        ) : null}
      </View>
      <TransporterField name={form.transporter?.name ?? 'Self'} onPress={() => setPicking(true)} disabled={dispatched} />
      <View style={styles.pair}>
        <View style={styles.fill}>
          <TextField label="Driver name" value={form.driverName} onChangeText={(v) => set({ driverName: v })} maxLength={60} editable={!dispatched} error={errors.driverName} />
        </View>
        <View style={styles.fill}>
          <TextField
            label="Driver phone"
            value={form.driverPhone}
            onChangeText={(v) => set({ driverPhone: v })}
            keyboardType="phone-pad"
            maxLength={14}
            editable={!dispatched}
            error={errors.driverPhone}
          />
        </View>
      </View>
      <TextField
        label="LR number"
        value={form.lrNo}
        onChangeText={(v) => set({ lrNo: v })}
        placeholder="Add LR number"
        maxLength={30}
        hint={editing ? undefined : 'Optional, can be added later'}
      />
      {withPlan && !dispatched ? (
        <LoadPlan
          sub={sub}
          truck={truck}
          basis={basis}
          plan={form.plan}
          onChange={(id, row) => set({ plan: { ...form.plan, [id]: row } })}
          error={errors.plan}
        />
      ) : null}
      {editing ? (
        <View style={[styles.banner, { backgroundColor: t.brs }]}>
          <Icon name="clock" size={18} color={t.brt} />
          <Text color="brt" style={[styles.fill, styles.small]}>
            Changes are saved to the order’s activity log. The supervisor sees the new details on the next sync.
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <TransporterPickerSheet
        visible={picking}
        onClose={() => setPicking(false)}
        onPick={(p) => {
          set({ transporter: p });
          setPicking(false);
        }}
      />
      {latest ? <CancelTruckSheet truck={latest} visible={cancelling} onClose={() => setCancelling(false)} onCancelled={() => router.back()} /> : null}
    </Screen>
  );
}

type FieldErrors = Extract<ReturnType<typeof check>, { ok: false }>['errors'];

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 12, paddingHorizontal: 8, paddingBottom: 4 },
  heading: { fontSize: 15, lineHeight: 20 },
  fill: { flex: 1, minWidth: 0 },
  small: { fontSize: 13, lineHeight: 18 },
  reload: { height: 44, paddingHorizontal: 14 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12 },
  gap: { gap: 8 },
  chips: { gap: 8, alignItems: 'center' },
  recent: { marginRight: 2 },
  pair: { flexDirection: 'row', gap: 12 },
  buttons: { flexDirection: 'row', gap: 10 },
});
