import {
  MAX_READING_KG,
  type Truck,
  type UnitBasis,
  can,
  formatRupees,
  netKg as netOf,
  parseQtyInput,
  plausibility,
  toDisplayQty,
  weightKgSchema,
} from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { ApiError } from '../../api/client';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useCorrectWeight } from '../../api/hooks/rejections';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH } from '../../theme/tokens';
import { Button, Keypad, Text, TextField, WeightReadout } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { messageFor } from '../messages';
import { type Allocation, SplitStep } from '../supervisor/SplitStep';

const MIN_REASON = 3;
type Field = 'tare' | 'gross';

/** A weight as the keypad types it: the user's basis, no grouping commas. */
const keypadText = (kg: number | null, basis: UnitBasis) => (kg === null ? '' : toDisplayQty(kg, basis).replace(/,/g, ''));

/** "−2.180 MT" / "+0.500 MT" / "0.000 MT". */
export function signedQty(kg: number, basis: UnitBasis): string {
  const abs = toDisplayQty(Math.abs(kg), basis, { withUnit: true });
  return kg < 0 ? `−${abs}` : kg > 0 ? `+${abs}` : abs;
}

function refusal(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'STALE') return 'Someone else changed this truck. Check the weights and save again.';
    if (e.code === 'TRUCK_LOCKED') return 'Only a truck awaiting approval or dispatched can be changed, and this one has changed.';
  }
  return messageFor(e);
}

/**
 * Owner and city staff (TON-57), on a truck awaiting approval ("Change weights") or dispatched
 * ("Correct weight"): new tare and gross (both weighments are superseded), the split when the
 * truck carries more than one line, and a reason. After dispatch the broker earning is rewritten
 * at the rates fixed at dispatch; money roles see its ₹ difference, after the save.
 */
export function CorrectWeightSheet({ truck, visible, onClose }: { truck: Truck; visible: boolean; onClose(): void }) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { height } = useWindowDimensions();
  const { data: me } = useMe();
  const correct = useCorrectWeight();
  const once = useSingleFlight();
  const submitKey = useSubmitKey();
  const [field, setField] = useState<Field>('gross');
  const [texts, setTexts] = useState({ tare: '', gross: '' });
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'weigh' | 'split'>('weigh');
  const [askedPct, setAskedPct] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<{ before: Truck; after: Truck } | null>(null);

  // Fill from the truck when the sheet opens; a refetch meanwhile (STALE) keeps what was typed.
  useEffect(() => {
    if (!visible) return;
    setField('gross');
    setTexts({ tare: keypadText(truck.tareKg, basis), gross: keypadText(truck.grossKg, basis) });
    setReason('');
    setStep('weigh');
    setAskedPct(null);
    setError(undefined);
    setSaved(null);
  }, [visible]); // only on open, not on every refetch of the truck

  const tare = parseQtyInput(texts.tare, basis);
  const gross = parseQtyInput(texts.gross, basis);
  const tareKg = tare.ok ? tare.value : null;
  const grossKg = gross.ok ? gross.value : null;
  const net = tareKg !== null && grossKg !== null ? netOf(grossKg, tareKg) : null;
  const oldNet = truck.netKg ?? 0;
  const planned = truck.plan.reduce((s, p) => s + p.plannedKg, 0);
  const unchanged = tareKg === truck.tareKg && grossKg === truck.grossKg;

  let problem: string | null = null;
  if (!weightKgSchema.safeParse(tareKg).success || !weightKgSchema.safeParse(grossKg).success) problem = 'Enter both weights';
  else if ((tareKg ?? 0) > MAX_READING_KG || (grossKg ?? 0) > MAX_READING_KG)
    problem = `A reading is at most ${toDisplayQty(MAX_READING_KG, basis, { withUnit: true })}`;
  else if (net !== null && net <= 0) problem = 'Gross must be more than the tare';
  const reasonOk = reason.trim().length >= MIN_REASON;
  const ready = problem === null && !unchanged && reasonOk && !correct.isPending;

  const edit = (f: Field, v: string) => {
    setTexts((prev) => ({ ...prev, [f]: v }));
    setAskedPct(null);
  };

  const submit = async (allocations: Allocation[]) => {
    if (tareKg === null || grossKg === null) return;
    setError(undefined);
    const body = { tareKg, grossKg, allocations, reason: reason.trim(), version: truck.version };
    // The key follows what is sent: a changed weight, reason or version is a new request.
    const key = submitKey.key(JSON.stringify(body));
    try {
      const after = await correct.mutateAsync({ id: truck.id, body, key });
      submitKey.settle();
      setSaved({ before: truck, after });
    } catch (e) {
      submitKey.settle(e);
      setError(refusal(e));
      // The split is computed from the weights: back to them so the person can check.
      setStep('weigh');
    }
  };

  const next = () => {
    if (!ready || net === null) return;
    const pct = plausibility(net, planned) === 'ok' ? null : Math.round((net * 100) / planned);
    if (pct !== null && askedPct === null) {
      setAskedPct(pct);
      return;
    }
    const [only, ...more] = truck.plan;
    if (only && more.length === 0) void once(() => submit([{ orderLineId: only.orderLineId, netKg: net }]));
    else setStep('split');
  };

  // Before approval nothing is dispatched or earned yet: the weights simply change.
  const pending = truck.state === 'weighed';
  const title = `${pending ? 'Change weights' : 'Correct weight'} · ${truck.vehicleNo}`;
  const close = () => (correct.isPending ? undefined : onClose());

  if (saved) {
    const owner = me ? can(me.role, 'money.view') : false;
    const before = saved.before.earningRupees;
    const after = saved.after.earningRupees;
    return (
      <Sheet visible={visible} title={title} onClose={close}>
        <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: t.oks }]}>
          <Text weight="semibold" color="okt">
            {pending ? 'Weights changed' : 'Weight corrected'}
          </Text>
          <Text numeric>{`Net ${toDisplayQty(saved.before.netKg ?? 0, basis)} → ${toDisplayQty(saved.after.netKg ?? 0, basis, { withUnit: true })}`}</Text>
          {owner && !pending && before !== undefined && after !== undefined ? (
            <Text numeric>{`Broker earning ${formatRupees(before)} → ${formatRupees(after)} (${after > before ? '+' : ''}${formatRupees(after - before)})`}</Text>
          ) : null}
        </View>
        <Button onPress={onClose}>Done</Button>
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} title={title} onClose={close} busy={correct.isPending}>
      <ScrollView style={{ maxHeight: height * 0.78 }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 'split' && net !== null ? (
          <>
            <Button variant="secondary" disabled={correct.isPending} onPress={() => setStep('weigh')}>
              Back to the weights
            </Button>
            <SplitStep
              plan={truck.plan}
              netKg={net}
              basis={basis}
              saving={correct.isPending}
              saveLabel="Save correction"
              onSave={(allocations) => void once(() => submit(allocations))}
            />
          </>
        ) : (
          <>
            <View style={styles.tiles} accessibilityRole="radiogroup" accessibilityLabel="Weight to change">
              {(['tare', 'gross'] as const).map((f) => (
                <WeightTile key={f} field={f} value={texts[f]} basis={basis} selected={field === f} onPress={() => setField(f)} />
              ))}
            </View>
            <View style={[styles.net, { backgroundColor: t.ctl }]} accessible accessibilityLiveRegion="polite">
              <Text color="tx2" style={styles.fill}>
                Net
              </Text>
              <View style={styles.right}>
                <Text numeric weight="semibold">
                  {net === null || net <= 0 ? '—' : `${toDisplayQty(oldNet, basis)} → ${toDisplayQty(net, basis, { withUnit: true })}`}
                </Text>
                {net !== null && net > 0 ? (
                  <Text numeric variant="caption" color={net < oldNet ? 'dgt' : net > oldNet ? 'okt' : 'tx3'}>
                    {signedQty(net - oldNet, basis)}
                  </Text>
                ) : null}
              </View>
            </View>
            <Keypad value={texts[field]} basis={basis} onChange={(v) => edit(field, v)} />
            <TextField
              label="Reason for the correction"
              placeholder="e.g. Weighbridge recalibrated"
              value={reason}
              onChangeText={setReason}
              maxLength={200}
              hint={`At least ${MIN_REASON} characters`}
            />
            <Text variant="caption">
              {pending ? 'Nothing is dispatched until you approve' : 'Broker earning is recalculated with the rates at dispatch'}
            </Text>
            {problem && !(problem === 'Enter both weights' && texts[field] === '') ? (
              <Text color="dgt" accessibilityLiveRegion="polite">
                {problem}
              </Text>
            ) : null}
            {askedPct !== null ? (
              <Text color="wnt" accessibilityRole="alert">
                {`Net is ${askedPct} % of the planned load. Check the weights, or save anyway.`}
              </Text>
            ) : null}
            {error ? (
              <Text color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
                {error}
              </Text>
            ) : null}
            <Button disabled={!ready} loading={correct.isPending} onPress={next}>
              {askedPct !== null ? 'Save anyway' : truck.plan.length > 1 ? 'Next · split the net' : 'Save correction'}
            </Button>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function WeightTile({
  field,
  value,
  basis,
  selected,
  onPress,
}: {
  field: Field;
  value: string;
  basis: UnitBasis;
  selected: boolean;
  onPress(): void;
}) {
  const { t } = useTheme();
  const label = field === 'tare' ? 'Tare' : 'Gross';
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${label}, ${value || '0'} ${basis === 'mt' ? 'tonnes' : 'kilograms'}`}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={[
        styles.tile,
        { backgroundColor: selected ? t.brs : t.card, borderColor: selected ? t.br : t.bd, borderWidth: selected ? 1.5 : 1 },
      ]}
    >
      <Text variant="caption" color={selected ? 'brt' : 'tx2'}>
        {label}
      </Text>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <WeightReadout value={value} basis={basis} color={field === 'tare' ? 'vi' : 'tx'} compact />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, paddingBottom: 4 },
  card: { padding: 14, borderRadius: 12, gap: 4 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, minHeight: MIN_TOUCH, padding: 10, borderRadius: 14, gap: 2 },
  net: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  right: { alignItems: 'flex-end' },
  fill: { flex: 1, minWidth: 0 },
});
