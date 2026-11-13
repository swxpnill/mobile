import {
  LENGTH_UNITS,
  type LengthUnit,
  type PricingMethod,
  type Product,
  billedRate,
  formatLength,
  formatRupees,
  lineValue,
  parseQtyInput,
  parseRateInput,
  toDisplayRate,
  unitLabel,
} from '@tonnage/shared';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { Button, Chip, ChoiceRow, Group, SegmentedControl, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { type LineDraft, newLine } from './wizard';

const COMMON_LENGTHS = [6, 9, 10, 12, 13];

/**
 * Canvas board 09: one line for one company. Products are those this company makes; the rate
 * shows how it is derived (basic + conversion) and typing overrides it. `locked` (a dispatched
 * line edited by city staff) keeps rate and overprice read-only and quantity ≥ dispatched.
 */
export function AddLineSheet({
  visible,
  companyName,
  products,
  pricingMethod,
  basicRate,
  brokerName,
  commissionText,
  initial,
  locked,
  onSave,
  onRemove,
  onClose,
}: {
  visible: boolean;
  companyName: string;
  products: Product[];
  pricingMethod: PricingMethod;
  /** Parsed basic rate (₹/MT) or null. */
  basicRate: number | null;
  brokerName: string | null;
  commissionText: string;
  initial: LineDraft | null;
  locked?: { minKg: number; reason: string };
  onSave(line: LineDraft, another: boolean): void;
  onRemove?: () => void;
  onClose(): void;
}) {
  const basis = useDisplayBasis();
  const [line, setLine] = useState<LineDraft>(initial ?? newLine(''));
  const [other, setOther] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (visible) {
      setLine(initial ?? newLine(products[0]?.id ?? ''));
      setOther('');
      setError(undefined);
    }
  }, [visible, initial]);

  const product = products.find((p) => p.id === line.productId);
  const unit = unitLabel(basis);
  const conv = product?.conversionPerMt ?? 0;
  const derived = pricingMethod === 'basic_conversion' && basicRate !== null ? basicRate + conv : null;
  const qty = parseQtyInput(line.qty, basis);
  const typed = line.rate.trim() === '' ? null : parseRateInput(line.rate, basis);
  const over = line.overprice.trim() === '' ? null : parseRateInput(line.overprice, basis);
  const rate = typed ? (typed.ok ? typed.value : null) : derived;
  const overprice = over ? (over.ok ? over.value : 0) : 0;
  const amount = qty.ok && rate !== null ? lineValue(qty.value, billedRate(rate, overprice)) : null;
  const lengths = useMemo(() => {
    const std = (product?.standardLengths ?? []).filter((l) => l.unit === line.length.unit).map((l) => l.value);
    return [...new Set([...std, ...(line.length.unit === 'm' ? COMMON_LENGTHS : [])])].sort((a, b) => a - b);
  }, [product, line.length.unit]);
  const set = (c: Partial<LineDraft>) => setLine((x) => ({ ...x, ...c }));

  const save = (another: boolean) => {
    if (!product) return setError('Choose the product');
    if (!qty.ok || qty.value <= 0) return setError(qty.ok ? 'Enter the quantity' : qty.error === 'TOO_MANY_DECIMALS' ? 'Quantity: up to 3 decimals' : 'Enter the quantity');
    if (locked && qty.value < locked.minKg) return setError(locked.reason);
    if (pricingMethod === 'direct' && rate === null) return setError('Enter the rate');
    if (typed && !typed.ok) return setError('Rate: up to 3 decimals');
    if (over && !over.ok) return setError('Overprice: up to 3 decimals');
    setError(undefined);
    onSave(line, another);
    if (another) setLine({ ...newLine(line.productId), length: { ...line.length, value: line.length.value }, rate: line.rate, overprice: line.overprice });
  };

  return (
    <Sheet visible={visible} title={initial ? 'Edit line' : 'Add line'} onClose={onClose}>
      <Text variant="caption" style={styles.sub}>
        {companyName}
      </Text>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Text variant="caption" weight="medium">
          Product
        </Text>
        {products.length === 0 ? (
          <Text color="tx2">This company makes no active product yet. Add one in More → Products.</Text>
        ) : (
          <Group>
            {products.map((p) => (
              <ChoiceRow
                key={p.id}
                kind="radio"
                title={p.displayName}
                detail={p.conversionPerMt ? `+${toDisplayRate(p.conversionPerMt, basis)} conv.` : undefined}
                checked={p.id === line.productId}
                disabled={Boolean(locked) && p.id !== line.productId}
                onPress={() => set({ productId: p.id })}
              />
            ))}
          </Group>
        )}
        <View style={styles.inline}>
          <Text variant="caption" weight="medium" style={styles.fill}>
            Length
          </Text>
          <SegmentedControl
            accessibilityLabel="Length unit"
            value={line.length.unit}
            onChange={(u: LengthUnit) => set({ length: { value: line.length.value, unit: u } })}
            options={LENGTH_UNITS.map((u) => ({ value: u, label: u }))}
          />
        </View>
        <View style={styles.chips}>
          {lengths.map((v) => (
            <Chip key={v} label={`${v}`} selected={line.length.value === v} onPress={() => set({ length: { ...line.length, value: v } })} />
          ))}
        </View>
        <TextField
          label="Other length"
          value={other}
          onChangeText={(v) => {
            setOther(v);
            const n = Number(v);
            if (Number.isInteger(n) && n >= 1 && n <= 100) set({ length: { ...line.length, value: n } });
          }}
          hint={`Any value from 1 to 100 · now ${formatLength(line.length)}`}
          keyboardType="number-pad"
          maxLength={3}
        />
        <TextField
          label="Quantity"
          value={line.qty}
          onChangeText={(v) => set({ qty: v })}
          hint={locked ? locked.reason : unit}
          keyboardType={basis === 'mt' ? 'decimal-pad' : 'number-pad'}
          maxLength={12}
        />
        <TextField
          label={`Rate per ${unit}`}
          prefix="₹"
          value={line.rate}
          onChangeText={(v) => set({ rate: v })}
          editable={!locked}
          placeholder={derived !== null ? toDisplayRate(derived, basis).replace('₹', '') : undefined}
          hint={
            locked
              ? 'Locked · this line has dispatches'
              : derived !== null
                ? `Rate = basic ${toDisplayRate(basicRate ?? 0, basis)} + conversion ${toDisplayRate(conv, basis)}. Type to override.`
                : 'Before GST'
          }
          keyboardType="decimal-pad"
          maxLength={12}
        />
        {brokerName ? (
          <TextField
            label={`Broker overprice per ${unit}`}
            prefix="+₹"
            value={line.overprice}
            onChangeText={(v) => set({ overprice: v })}
            editable={!locked}
            hint={`Charged to the customer and paid to ${brokerName}${commissionText ? `, on top of the ${commissionText} commission` : ''}`}
            keyboardType="decimal-pad"
            maxLength={12}
          />
        ) : null}
        <View style={styles.amount} accessible accessibilityLabel={`Line amount ${amount === null ? 'not set' : formatRupees(amount)}`}>
          <Text variant="caption" style={styles.fill}>
            Line amount
          </Text>
          <Text weight="semibold" numeric>
            {amount === null ? '—' : formatRupees(amount)}
          </Text>
        </View>
        {error ? (
          <Text color="dgt" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.buttons}>
        {initial && onRemove ? (
          <Button variant="secondary" onPress={onRemove} disabled={Boolean(locked)}>
            Remove
          </Button>
        ) : !initial ? (
          <Button variant="secondary" onPress={() => save(true)}>
            Add another length
          </Button>
        ) : null}
        <Button onPress={() => save(false)} style={styles.fill}>
          {initial ? 'Save line' : 'Add line'}
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: -8 },
  scroll: { maxHeight: 520 },
  body: { gap: 12, paddingBottom: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  amount: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  buttons: { flexDirection: 'row', gap: 10 },
});
