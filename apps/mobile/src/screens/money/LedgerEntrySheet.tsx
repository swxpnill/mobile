import {
  type LedgerEntry,
  PAYMENT_MODE_LABEL,
  type UnitBasis,
  formatRupees,
  istDateOf,
  toDisplayQty,
  toDisplayRate,
} from '@tonnage/shared';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useReversePayment } from '../../api/hooks/money';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { dateLabel, istClock } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, Button, showToast, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { messageFor } from '../messages';
import { ledgerTitle, signedRupees } from './captions';

/** A label and its value, as one line a screen reader reads together. */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text color="tx2" style={styles.label}>
        {label}
      </Text>
      <Text numeric style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

/**
 * One ledger row in full (board 06, tap a row). A live payment can be reversed by `broker.pay`
 * roles with a reason (Ruling 6); earnings change only through a weight correction.
 */
export function LedgerEntrySheet({
  entry: entryIn,
  reversed: reversedIn,
  basis,
  canReverse,
  onClose,
}: {
  /** The row to show; `null` closes the sheet. */
  entry: LedgerEntry | null;
  /** The row this reversal undoes, when loaded. */
  reversed?: LedgerEntry;
  basis: UnitBasis;
  canReverse: boolean;
  onClose(): void;
}) {
  const { t } = useTheme();
  const reverse = useReversePayment();
  const once = useSingleFlight();
  const key = useSubmitKey();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    setAsking(false);
    setReason('');
    setError(undefined);
  }, [entryIn?.id]);

  // The last entry stays rendered while the sheet slides out after `entry` turns null.
  const lastRef = useRef<{ entry: LedgerEntry; reversed?: LedgerEntry } | null>(null);
  if (entryIn) lastRef.current = { entry: entryIn, reversed: reversedIn };
  const shown = lastRef.current;
  if (!shown) return null;
  const { entry, reversed } = shown;
  const p = entry.payment;
  const total = -entry.amountRupees;
  const reversible = canReverse && entry.kind === 'payment' && entry.reversedById === null;
  const reasonOk = reason.trim().length >= 3;

  const send = async () => {
    if (!reasonOk) return;
    setError(undefined);
    const r = reason.trim();
    try {
      await reverse.mutateAsync({ entryId: entry.id, reason: r, key: key.key(JSON.stringify({ id: entry.id, r })) });
      key.settle();
      showToast('Payment reversed');
      onClose();
    } catch (e) {
      key.settle(e);
      setError(messageFor(e));
    }
  };

  return (
    <Sheet visible={entryIn !== null} title={ledgerTitle(entry, reversed)} onClose={onClose} busy={reverse.isPending}>
      <View style={styles.amountRow}>
        <Text
          variant="title"
          numeric
          color={entry.amountRupees > 0 ? 'okt' : 'dgt'}
          style={entry.reversedById ? styles.struck : null}
        >
          {signedRupees(entry.amountRupees)}
        </Text>
        {entry.reversedById ? <Badge kind="nu">Reversed</Badge> : null}
      </View>
      <View style={[styles.box, { borderColor: t.bd }]}>
        {p ? (
          <>
            <Line label="Paid" value={formatRupees(p.paidRupees)} />
            {p.tdsRupees > 0 ? <Line label="TDS" value={formatRupees(p.tdsRupees)} /> : null}
            <Line label="Paid by" value={PAYMENT_MODE_LABEL[p.mode]} />
            {p.utr ? (
              <View accessible accessibilityLabel={`Reference, ${p.utr}`} style={styles.line}>
                <Text color="tx2" style={styles.label}>
                  Reference
                </Text>
                <Text numeric style={styles.value}>{`${p.mode === 'cheque' ? 'Cheque no.' : 'UTR'} ${p.utr}`}</Text>
              </View>
            ) : null}
            <Line label="Paid on" value={dateLabel(p.paidOn)} />
          </>
        ) : null}
        {entry.truck ? (
          <>
            <Line label="Sub-order" value={entry.truck.subOrderNumber} />
            <Line label="Vehicle" value={entry.truck.vehicleNo} />
            <Line label="Net" value={toDisplayQty(Math.abs(entry.truck.netKg), basis, { withUnit: true })} />
          </>
        ) : null}
        {entry.earningLines.map((l, i) => (
          <Line
            // Lines carry no id; their order is fixed for the row.
            key={`${i}-${l.productName}`}
            label={l.productName || 'Line'}
            value={`${toDisplayQty(Math.abs(l.netKg), basis, { withUnit: true })} × ${toDisplayRate(l.commissionPerMt, basis)}${
              l.overpricePerMt > 0 ? ` + ${toDisplayRate(l.overpricePerMt, basis)}` : ''
            }`}
          />
        ))}
        {entry.kind === 'reversal' && entry.note ? <Line label="Reason" value={entry.note} /> : null}
        <Line label="Recorded" value={`${entry.createdBy.name} · ${dateLabel(istDateOf(entry.createdAt))} ${istClock(entry.createdAt)}`} />
      </View>

      {reversible && !asking ? (
        <Button variant="danger" onPress={() => setAsking(true)}>
          Reverse payment
        </Button>
      ) : null}
      {reversible && asking ? (
        <>
          <Text color="tx2">The payment stays in the ledger marked Reversed, and the due goes back up.</Text>
          <TextField label="Reason" value={reason} onChangeText={setReason} placeholder="Why it is reversed" maxLength={200} />
          <View style={styles.message}>
            {error ? (
              <Text variant="caption" color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
                {error}
              </Text>
            ) : null}
          </View>
          <Button variant="danger" disabled={!reasonOk} loading={reverse.isPending} onPress={() => void once(send)}>
            {`Reverse ${formatRupees(total)}`}
          </Button>
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  struck: { textDecorationLine: 'line-through' },
  box: { borderWidth: 1, borderRadius: 12, paddingVertical: 4 },
  line: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 8 },
  label: { flexShrink: 0 },
  value: { flex: 1, textAlign: 'right' },
  message: { minHeight: 16 },
});
