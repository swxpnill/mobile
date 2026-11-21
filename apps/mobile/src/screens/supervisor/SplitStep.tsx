import {
  type Task,
  type UnitBasis,
  parseQtyInput,
  splitProRata,
  toDisplayQty,
} from '@tonnage/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, Group, Row, Text, TextField } from '../../ui';

export type Allocation = { orderLineId: string; netKg: number };

/**
 * Gross with more than one plan line: how the net splits over the lines. Prefilled pro rata
 * (largest remainder, exact to the kg); Save only while the lines sum to exactly net.
 */
export function SplitStep({
  plan,
  netKg,
  basis,
  saving,
  saveLabel = 'Save gross · send for approval',
  onSave,
}: {
  plan: Task['plan'];
  netKg: number;
  basis: UnitBasis;
  saving: boolean;
  /** The owner's weight correction reuses this step with its own action. */
  saveLabel?: string;
  onSave(allocations: Allocation[]): void;
}) {
  const { t } = useTheme();
  const [texts, setTexts] = useState(() =>
    splitProRata(netKg, plan).map((a) => toDisplayQty(a.netKg, basis)),
  );

  const parsed = texts.map((s) => parseQtyInput(s, basis));
  const allValid = parsed.every((p) => p.ok);
  const sum = parsed.reduce((s, p) => s + (p.ok ? p.value : 0), 0);
  const left = netKg - sum;
  const ready = allValid && left === 0;

  return (
    <View style={styles.wrap}>
      <Group>
        <Row>
          <Text color="tx2" style={styles.fill}>
            Net loaded
          </Text>
          <Text numeric weight="semibold" color="okt">
            {toDisplayQty(netKg, basis, { withUnit: true })}
          </Text>
        </Row>
      </Group>
      <Text variant="caption">Split the net over the order lines</Text>
      {plan.map((p, i) => {
        const r = parsed[i];
        return (
          <TextField
            key={p.orderLineId}
            label={p.productName}
            value={texts[i] ?? ''}
            onChangeText={(v) => setTexts((prev) => prev.map((x, j) => (j === i ? v : x)))}
            keyboardType={basis === 'mt' ? 'decimal-pad' : 'number-pad'}
            maxLength={9}
            hint={`Planned ${toDisplayQty(p.plannedKg, basis, { withUnit: true })}`}
            error={
              r && !r.ok
                ? r.error === 'TOO_MANY_DECIMALS'
                  ? 'Up to 3 decimals'
                  : 'Enter a weight'
                : undefined
            }
          />
        );
      })}
      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={`Left to allocate, ${toDisplayQty(left, basis, { withUnit: true })}`}
        style={[styles.left, { backgroundColor: left === 0 ? t.oks : t.wns }]}
      >
        <Text weight="medium" color={left === 0 ? 'okt' : 'wnt'} style={styles.fill}>
          Left to allocate
        </Text>
        <Text numeric weight="semibold" color={left === 0 ? 'okt' : 'wnt'}>
          {left < 0
            ? `−${toDisplayQty(-left, basis, { withUnit: true })}`
            : toDisplayQty(left, basis, { withUnit: true })}
        </Text>
      </View>
      <Button
        disabled={!ready}
        loading={saving}
        onPress={() =>
          onSave(
            plan.map((p, i) => {
              const r = parsed[i];
              return { orderLineId: p.orderLineId, netKg: r?.ok ? r.value : 0 };
            }),
          )
        }
      >
        {saveLabel}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  fill: { flex: 1, minWidth: 0 },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
});
