import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABEL,
  type PaymentMode,
  UTR_REQUIRED,
  dueAfterPayment,
  dueState,
  formatRupees,
  groupIndian,
  halfOf,
  istDateOf,
  validationDetailsSchema,
} from '@tonnage/shared';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ApiError } from '../../api/client';
import { useRecordPayment } from '../../api/hooks/money';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { addDays, dateLabel } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { fontFamily, MIN_TOUCH, SMALL_TEXT_MAX_SCALE } from '../../theme/tokens';
import { Avatar, Button, CalendarSheet, IconButton, showToast, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { messageFor } from '../messages';

/** Rupee inputs keep digits only (whole rupees), up to the largest payment the server takes. */
const MAX_PAID = 100_000_000;
const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9);
const toRupees = (s: string) => (s === '' ? 0 : Number(s));
const UTR_FORMAT = /^[A-Za-z0-9]{4,30}$/;

/** The first inline problem with the form, or none (Ruling 5; the server checks the same). */
export function paymentProblem(f: { paid: number; tds: number; mode: PaymentMode; utr: string }): string | undefined {
  if (f.paid > MAX_PAID) return `Enter at most ${formatRupees(MAX_PAID)}`;
  if (f.tds > f.paid && f.paid > 0) return "TDS can't be more than the amount";
  const utr = f.utr.trim();
  if (utr === '' && UTR_REQUIRED.has(f.mode) && f.paid > 0) return 'UTR is needed for NEFT and UPI';
  if (utr !== '' && !UTR_FORMAT.test(utr)) return 'UTR is 4 to 30 letters or digits';
  return undefined;
}

/** A refused save in plain words: the field's own message for a 422, else the usual copy. */
function refusal(e: unknown): string {
  if (e instanceof ApiError && e.code === 'VALIDATION') {
    const details = validationDetailsSchema.safeParse(e.details);
    if (details.success && details.data[0]) return details.data[0].message;
  }
  return messageFor(e);
}

/** Board 33: record a payment to a broker. Idempotent per submit, so a retry never pays twice. */
export function RecordPaymentSheet({
  broker,
  dueRupees,
  visible,
  onClose,
}: {
  broker: { id: string; name: string };
  dueRupees: number;
  visible: boolean;
  onClose(): void;
}) {
  const { t, scale } = useTheme();
  const record = useRecordPayment(broker.id);
  const once = useSingleFlight();
  const key = useSubmitKey();
  const today = istDateOf(Date.now());
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('neft');
  const [utr, setUtr] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [tdsText, setTdsText] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string>();
  const [amountWidth, setAmountWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    setAmount('');
    setMode('neft');
    setUtr('');
    setPaidOn(istDateOf(Date.now()));
    setTdsText('');
    setPicking(false);
    setError(undefined);
  }, [visible]);

  const paid = toRupees(amount);
  const shownAmount = amount === '' ? '' : groupIndian(amount);
  const amountFont = { fontFamily: fontFamily.semibold, fontSize: 44 * scale, lineHeight: 52 * scale };
  const tds = toRupees(tdsText);
  const problem = paymentProblem({ paid, tds, mode, utr });
  const valid = paid >= 1 && problem === undefined;
  const after = dueState(dueAfterPayment(dueRupees, paid, tds));
  const afterText =
    after.kind === 'advance'
      ? `Advance after this payment ${formatRupees(after.rupees)}`
      : `Due after this payment ${formatRupees(after.rupees)}`;
  const now = dueState(dueRupees);
  const message = problem ?? error;

  const send = async () => {
    if (!valid) return;
    setError(undefined);
    const body = { paidRupees: paid, tdsRupees: tds, mode, utr: utr.trim() === '' ? null : utr.trim(), paidOn };
    try {
      // The key follows what is sent: a changed amount after a lost answer is a new payment.
      await record.mutateAsync({ body, key: key.key(JSON.stringify(body)) });
      key.settle();
      showToast('Payment recorded');
      onClose();
    } catch (e) {
      key.settle(e); // kept for the retry unless the server answered
      setError(refusal(e));
    }
  };

  const header = (
    <View style={styles.head}>
      <Avatar name={broker.name} tone="vi" size={44} />
      <View style={styles.fill}>
        <Text variant="heading" accessibilityRole="header" numberOfLines={1}>
          {`Pay ${broker.name}`}
        </Text>
        <Text variant="caption">
          {now.kind === 'due' ? 'Due now ' : now.kind === 'advance' ? 'Advance now ' : 'Nothing due '}
          {now.kind === 'clear' ? null : (
            <Text variant="caption" weight="semibold" color={now.kind === 'due' ? 'wnt' : 'okt'}>
              {formatRupees(now.rupees)}
            </Text>
          )}
        </Text>
      </View>
      <IconButton icon="close" label="Close" onPress={() => (record.isPending ? undefined : onClose())} />
    </View>
  );

  return (
    <Sheet visible={visible} title={`Pay ${broker.name}`} header={header} onClose={onClose} busy={record.isPending}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.amountBox}>
          <Text variant="caption" style={styles.amountLabel}>
            Amount paid
          </Text>
          <View style={styles.amountRow}>
            <Text weight="medium" color="tx3" style={styles.rupee}>
              ₹
            </Text>
            {/* Sized to its text (measured below), so the ₹ sits against the digits as one centred group. */}
            <TextInput
              accessibilityLabel="Amount paid"
              value={shownAmount}
              onChangeText={(s) => setAmount(digits(s))}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={t.tx3}
              style={[
                styles.amount,
                amountFont,
                { color: amount === '' ? t.tx3 : t.dgt, width: amountWidth === null ? undefined : amountWidth + 6 },
              ]}
            />
            <Text
              testID="amount-measure"
              numberOfLines={1}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onLayout={(e) => setAmountWidth(Math.ceil(e.nativeEvent.layout.width))}
              style={[styles.amount, styles.measure, amountFont]}
            >
              {shownAmount || '0'}
            </Text>
          </View>
          {now.kind === 'due' ? (
            <View style={styles.quick}>
              <Pill label={`Full ${formatRupees(dueRupees)}`} onPress={() => setAmount(String(dueRupees))} />
              <Pill label="Half" onPress={() => setAmount(String(halfOf(dueRupees)))} />
            </View>
          ) : null}
        </View>

        <View style={styles.field}>
          <Text variant="caption" weight="medium" color="tx2">
            Paid by
          </Text>
          <View style={styles.modes} accessibilityRole="radiogroup" accessibilityLabel="Paid by">
            {PAYMENT_MODES.map((m) => (
              <ModeChip key={m} label={PAYMENT_MODE_LABEL[m]} selected={mode === m} onPress={() => setMode(m)} />
            ))}
          </View>
        </View>

        <View style={styles.pair}>
          <View style={styles.utr}>
            <TextField
              label="UTR / reference"
              value={utr}
              onChangeText={(s) => setUtr(s.replace(/\s/g, ''))}
              placeholder={mode === 'cheque' ? 'Cheque no.' : UTR_REQUIRED.has(mode) ? 'UTR' : 'Optional'}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={30}
            />
          </View>
          <View style={styles.date}>
            <Text variant="caption" weight="medium" color="tx2" style={styles.dateLabel}>
              Date
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Date, ${dateLabel(paidOn)}`}
              onPress={() => setPicking(true)}
              style={({ pressed }) => [styles.dateBox, { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd2 }]}
            >
              <Text numeric style={styles.fill}>
                {dateLabel(paidOn, { year: paidOn.slice(0, 4) !== today.slice(0, 4), pad: true })}
              </Text>
            </Pressable>
          </View>
        </View>

        <TextField
          label="TDS deducted (optional)"
          value={tdsText === '' ? '' : groupIndian(tdsText)}
          onChangeText={(s) => setTdsText(digits(s))}
          keyboardType="number-pad"
          prefix="₹"
          placeholder="0"
        />

        {/* One reserved line for the form's message, so nothing moves when it appears. */}
        <View style={styles.message}>
          {message ? (
            <Text variant="caption" color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
              {message}
            </Text>
          ) : null}
        </View>

        <View style={[styles.after, { backgroundColor: t.oks }]} accessible accessibilityLabel={afterText}>
          <Text color="tx2" style={styles.fill}>
            {after.kind === 'advance' ? 'Advance after this payment' : 'Due after this payment'}
          </Text>
          <Text weight="semibold" numeric color="okt">
            {formatRupees(after.rupees)}
          </Text>
        </View>
      </ScrollView>

      <Button disabled={!valid} loading={record.isPending} onPress={() => void once(send)}>
        {paid > 0 ? `Record ${formatRupees(paid)} payment` : 'Record payment'}
      </Button>

      {picking ? (
        <CalendarSheet
          title="Paid on"
          value={paidOn}
          max={today}
          min={addDays(today, -365)}
          onPick={(d) => {
            setPaidOn(d);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </Sheet>
  );
}

function Pill({ label, onPress }: { label: string; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [styles.pill, { backgroundColor: pressed ? t.act : t.ctl }]}
    >
      <Text weight="medium" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} style={styles.pillText}>
        {label}
      </Text>
    </Pressable>
  );
}

function ModeChip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, selected }}
      onPress={onPress}
      hitSlop={{ top: 2, bottom: 2 }}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: t.brs, borderColor: t.br, borderWidth: 1.5 }
          : { backgroundColor: t.card, borderColor: t.bd2, borderWidth: 1 },
      ]}
    >
      <Text weight="medium" color={selected ? 'brt' : 'tx2'} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fill: { flex: 1, minWidth: 0 },
  body: { gap: 18, paddingBottom: 4 },
  amountBox: { alignItems: 'center', paddingVertical: 8 },
  amountLabel: { fontSize: 13 },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 4, marginTop: 4 },
  rupee: { fontSize: 28, lineHeight: 34 },
  amount: { maxWidth: 280, textAlign: 'center', letterSpacing: -1.3, padding: 0 },
  measure: { position: 'absolute', opacity: 0, left: 0, top: 0 },
  quick: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 10 },
  pill: { minHeight: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center' },
  pillText: { fontSize: 13 },
  field: { gap: 8 },
  modes: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, minHeight: MIN_TOUCH - 4, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  pair: { flexDirection: 'row', gap: 12 },
  utr: { flex: 1.4, minWidth: 0 },
  date: { flex: 1, minWidth: 0, gap: 6 },
  dateLabel: { paddingHorizontal: 4 },
  dateBox: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  message: { minHeight: 16, marginTop: -8, marginBottom: -8 },
  after: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12 },
});
