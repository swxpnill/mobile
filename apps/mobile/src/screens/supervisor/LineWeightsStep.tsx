import {
  type LineWeightsProblem,
  MAX_READING_KG,
  type Task,
  type UnitBasis,
  checkLineWeights,
  lineDiff,
  parseQtyInput,
  toDisplayQty,
  unitLabel,
} from '@tonnage/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { istClock } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, type Tokens, radius } from '../../theme/tokens';
import { Button, Group, Icon, Keypad, Row, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { TourTarget } from '../../onboarding/TourTarget';
import { useFirstTip } from '../../onboarding/useFirstTip';

/** One product row on the truck: from its plan, or added from the sub-order (no plan). */
interface WeighLine {
  orderLineId: string;
  name: string;
  /** Null for a line added from the sub-order (not on the truck's plan). */
  plannedKg: number | null;
  /** What was typed, in the person's unit basis; '' = no weight yet. */
  text: string;
}

export interface LineWeightsResult {
  grossKg: number;
  /** One per line with a weight over 0, in screen order (0-kg lines are left out, Ruling 6). */
  allocations: { orderLineId: string; netKg: number }[];
}

const PROBLEM: Record<LineWeightsProblem, (basis: UnitBasis) => string> = {
  LINE_BLANK: () => 'Enter a weight for every product',
  NOTHING_WEIGHED: () => 'Enter at least one weight',
  READING_TOO_HIGH: (basis) => `A weighbridge reading is at most ${toDisplayQty(MAX_READING_KG, basis, { withUnit: true })}`,
};

const netOf = (line: WeighLine, basis: UnitBasis): number | null => {
  if (line.text === '') return null;
  const parsed = parseQtyInput(line.text, basis);
  return parsed.ok ? parsed.value : null;
};

/**
 * TON-57 (Rulings 6–8): the gross step as one weight per product. The selected row takes the
 * keypad; gross is tare + Σ lines, calculated and read-only (`checkLineWeights`, shared with the
 * server's rules). Lines from the sub-order that are not on the truck can be added ("Add product")
 * and removed again; plan lines stay. Over or under the plan is information only.
 */
export function LineWeightsStep({
  task,
  basis,
  tareAt,
  saving,
  onSave,
}: {
  task: Task;
  basis: UnitBasis;
  /** When the tare was weighed ("Tare · weighed 10:12"); null when unknown. */
  tareAt: string | null;
  saving: boolean;
  onSave(result: LineWeightsResult): void;
}) {
  useFirstTip('weigh.lines');
  const { t } = useTheme();
  const [lines, setLines] = useState<WeighLine[]>(() =>
    task.plan.map((p) => ({ orderLineId: p.orderLineId, name: p.productName, plannedKg: p.plannedKg, text: '' })),
  );
  const [selected, setSelected] = useState(0);
  const [adding, setAdding] = useState(false);

  const tareKg = task.tareKg ?? 0;
  const nets = lines.map((l) => netOf(l, basis));
  const check = checkLineWeights(tareKg, nets);
  const grossKg = nets.every((n) => n === null) ? null : nets.reduce<number>((s, n) => s + (n ?? 0), tareKg);
  const q = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  const shown = new Set(lines.map((l) => l.orderLineId));
  const addable = task.lines.filter((l) => !shown.has(l.orderLineId));
  const current = lines[selected];

  const setText = (text: string) =>
    setLines((all) => all.map((l, i) => (i === selected ? { ...l, text } : l)));

  const add = (line: Task['lines'][number]) => {
    setLines((all) => [...all, { orderLineId: line.orderLineId, name: line.productName, plannedKg: null, text: '' }]);
    setSelected(lines.length);
    setAdding(false);
  };

  const remove = (index: number) => {
    setLines((all) => all.filter((_, i) => i !== index));
    setSelected((s) => (s > index ? s - 1 : s === index ? Math.max(0, index - 1) : s));
  };

  const save = () => {
    if (!check.ok || saving) return;
    onSave({
      grossKg: check.grossKg,
      allocations: lines
        .map((l, i) => ({ orderLineId: l.orderLineId, netKg: check.nets[i]! }))
        .filter((a) => a.netKg > 0),
    });
  };

  return (
    <>
      <View style={styles.kv} accessible accessibilityLabel={`Tare, ${q(tareKg)}${tareAt ? `, weighed ${istClock(tareAt)}` : ''}`}>
        <Text color="tx2" style={styles.fill}>
          {tareAt ? `Tare · weighed ${istClock(tareAt)}` : 'Tare'}
        </Text>
        <Text numeric weight="medium">
          {q(tareKg)}
        </Text>
      </View>

      <TourTarget id="weigh.lines">
      <View style={styles.lines} accessibilityRole="radiogroup" accessibilityLabel="Products on this truck">
        {lines.map((line, i) => (
          <LineRow
            key={line.orderLineId}
            line={line}
            netKg={nets[i] ?? null}
            basis={basis}
            selected={i === selected}
            onSelect={() => setSelected(i)}
            onRemove={line.plannedKg === null ? () => remove(i) : undefined}
            pendingKg={task.lines.find((l) => l.orderLineId === line.orderLineId)?.pendingKg ?? null}
          />
        ))}
      </View>
      </TourTarget>

      {addable.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add product"
          onPress={() => setAdding(true)}
          style={({ pressed }) => [styles.add, { borderColor: t.bd2 }, pressed ? { backgroundColor: t.act } : null]}
        >
          <Icon name="plus" size={18} color={t.brt} strokeWidth={2} />
          <Text weight="medium" color="brt">
            Add product
          </Text>
        </Pressable>
      ) : null}

      <View
        testID="gross-readout"
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={`Gross, ${grossKg === null ? 'not yet' : q(grossKg)}`}
        style={[styles.gross, { backgroundColor: t.card, borderColor: t.bd }]}
      >
        <View style={styles.fill}>
          <Text weight="medium">Gross</Text>
          <Text variant="caption">Tare + products · calculated</Text>
        </View>
        <Text numeric weight="semibold" style={styles.grossValue}>
          {grossKg === null ? '—' : toDisplayQty(grossKg, basis)}
        </Text>
        <Text weight="medium" color="tx2">
          {unitLabel(basis)}
        </Text>
      </View>

      <View style={styles.spacer} />
      {!check.ok ? (
        <Text color="tx2" accessibilityLiveRegion="polite" style={styles.center}>
          {PROBLEM[check.reason](basis)}
        </Text>
      ) : null}
      <Button disabled={!check.ok || saving} loading={saving} onPress={save}>
        Save weights · send for approval
      </Button>
      {current ? <Keypad value={current.text} onChange={setText} basis={basis} /> : null}

      <Sheet visible={adding} title="Add a product" onClose={() => setAdding(false)}>
        <Text color="tx2">Products on this order that are not on the truck yet.</Text>
        <Group>
          {addable.map((l) => (
            <Row key={l.orderLineId} onPress={() => add(l)} accessibilityLabel={`${l.productName}, ${q(l.pendingKg)} pending`}>
              <View style={styles.fill}>
                <Text weight="medium">{l.productName}</Text>
                <Text variant="caption">{`${q(l.pendingKg)} pending`}</Text>
              </View>
              <Icon name="plus" size={18} color={t.tx3} />
            </Row>
          ))}
        </Group>
      </Sheet>
    </>
  );
}

function LineRow({
  line,
  netKg,
  basis,
  selected,
  onSelect,
  onRemove,
  pendingKg,
}: {
  line: WeighLine;
  netKg: number | null;
  basis: UnitBasis;
  selected: boolean;
  onSelect(): void;
  /** Only for a line added from the sub-order. */
  onRemove?: () => void;
  pendingKg: number | null;
}) {
  const { t } = useTheme();
  const q = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  const diff = line.plannedKg !== null && netKg !== null ? lineDiff(netKg, line.plannedKg) : null;
  const look: { bg: keyof Tokens; fg: keyof Tokens; text: string } | null =
    diff === null
      ? null
      : diff.kind === 'over'
        ? { bg: 'wns', fg: 'wnt', text: `+${toDisplayQty(diff.kg, basis)} over · allowed` }
        : diff.kind === 'under'
          ? { bg: 'dgs', fg: 'dgt', text: `−${toDisplayQty(diff.kg, basis)} under · allowed` }
          : { bg: 'oks', fg: 'okt', text: 'Exact' };
  const context =
    line.plannedKg !== null
      ? `Planned ${q(line.plannedKg)}`
      : `Not on the plan${pendingKg !== null ? ` · ${q(pendingKg)} pending` : ''}`;
  const spoken = [line.name, context, netKg === null ? 'no weight yet' : `${q(netKg)} entered`, look?.text].filter(Boolean).join(', ');

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: t.card, borderColor: selected ? t.br : t.bd },
        selected ? styles.rowSelected : null,
      ]}
    >
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={spoken}
        onPress={onSelect}
        style={styles.rowMain}
      >
        <View style={styles.rowTop}>
          <Text weight="semibold" style={styles.fill} numberOfLines={2}>
            {line.name}
          </Text>
          <Text numeric weight="semibold" color={netKg === null ? 'tx3' : 'tx'} style={styles.value}>
            {line.text === '' ? '—' : line.text}
          </Text>
        </View>
        <View style={styles.rowBottom}>
          <Text variant="caption" style={styles.fill}>
            {context}
          </Text>
          {look ? (
            <View style={[styles.chip, { backgroundColor: t[look.bg] }]}>
              <Text weight="medium" color={look.fg} style={styles.small}>
                {look.text}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${line.name}`}
          onPress={onRemove}
          hitSlop={4}
          style={({ pressed }) => [styles.remove, { backgroundColor: pressed ? t.act : t.ctl }]}
        >
          <Icon name="close" size={16} color={t.tx2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  lines: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: radius.group, borderWidth: 1, paddingRight: 10 },
  rowSelected: { borderWidth: 2 },
  rowMain: { flex: 1, minWidth: 0, minHeight: MIN_TOUCH + 20, paddingVertical: 12, paddingLeft: 14, gap: 6 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  value: { fontSize: 20, lineHeight: 26, letterSpacing: -0.4 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.badge },
  small: { fontSize: 12, lineHeight: 16 },
  remove: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    borderRadius: radius.button,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  gross: { flexDirection: 'row', alignItems: 'baseline', gap: 6, padding: 16, borderRadius: radius.group, borderWidth: 1 },
  grossValue: { fontSize: 26, lineHeight: 32, letterSpacing: -0.6 },
  spacer: { flexGrow: 1, minHeight: 4 },
  center: { textAlign: 'center' },
});
