import { type SubOrder, type Truck, type UnitBasis, parseQtyInput, toDisplayQty, unitLabel } from '@tonnage/shared';
import { inputTheme } from '../../ui/inputTheme';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useParties } from '../../api/hooks/masters';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, SMALL_TEXT_MAX_SCALE, fontFamily } from '../../theme/tokens';
import { Avatar, Group, Icon, Row, SearchField, Text, useDebouncedValue } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { type PlanRowState, lineAssignable, lineLabel } from './assignForm';

/** Transporter field (canvas 07): opens the picker; shows "Self" for an own vehicle. */
export function TransporterField({ name, onPress, disabled }: { name: string; onPress(): void; disabled?: boolean }) {
  const { t } = useTheme();
  return (
    <View style={styles.field}>
      <Text variant="caption" weight="medium" color="tx2" style={styles.label}>
        Transporter
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Transporter, ${name}`}
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.box,
          { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd2, opacity: disabled ? 0.5 : 1 },
        ]}
      >
        <Icon name="truck" size={18} color={t.tx3} />
        <Text weight="medium" style={styles.fill} numberOfLines={1}>
          {name}
        </Text>
        <Icon name="chevronDown" size={18} color={t.tx3} />
      </Pressable>
    </View>
  );
}

/** Active transporters, searchable, plus "Self" (the customer's or our own vehicle). */
export function TransporterPickerSheet({
  visible,
  onPick,
  onClose,
}: {
  visible: boolean;
  onPick(p: { id: string; name: string } | null): void;
  onClose(): void;
}) {
  const { t } = useTheme();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const list = useParties({ type: 'transporter', active: true, ...(q ? { q } : {}) }, visible);
  return (
    <Sheet visible={visible} title="Choose transporter" onClose={onClose}>
      <SearchField value={search} onChangeText={setSearch} placeholder="Search transporters" />
      <Group>
        <Row onPress={() => onPick(null)} accessibilityLabel="Self, own vehicle">
          <Avatar name="Self" tone="nu" size={36} />
          <Text weight="medium" style={styles.fill}>
            Self
          </Text>
          <Text variant="caption">Own vehicle</Text>
        </Row>
        {(list.data ?? []).slice(0, 30).map((p) => (
          <Row key={p.id} onPress={() => onPick({ id: p.id, name: p.name })} accessibilityLabel={`${p.name}, ${p.city}`}>
            <Avatar name={p.name} tone="te" size={36} />
            <Text weight="medium" style={styles.fill} numberOfLines={1}>
              {p.name}
            </Text>
            <Text variant="caption">{p.city}</Text>
          </Row>
        ))}
      </Group>
      {list.isPending ? <ActivityIndicator color={t.br} accessibilityLabel="Loading" /> : null}
    </Sheet>
  );
}

/** Load plan (canvas 07): a checkbox per line, what is left on it, and the planned quantity. */
export function LoadPlan({
  sub,
  truck,
  basis,
  plan,
  onChange,
  error,
}: {
  sub: SubOrder;
  truck?: Truck;
  basis: UnitBasis;
  plan: Record<string, PlanRowState>;
  onChange(lineId: string, row: PlanRowState): void;
  error?: string;
}) {
  const { scheme, t, scale } = useTheme();
  const unit = unitLabel(basis);
  return (
    <View style={styles.field}>
      <Text variant="overline" style={styles.label}>
        Load plan
      </Text>
      <Group>
        {sub.lines.map((l) => {
          const row = plan[l.id] ?? { checked: false, qty: '' };
          const left = lineAssignable(l, truck);
          const kg = parseQtyInput(row.qty, basis);
          const over = row.checked && kg.ok && kg.value > Math.max(0, left);
          const label = lineLabel(l);
          return (
            <View key={l.id} style={styles.line}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={label}
                accessibilityState={{ checked: row.checked }}
                onPress={() => onChange(l.id, { ...row, checked: !row.checked })}
                style={styles.check}
              >
                <View
                  style={[
                    styles.box20,
                    row.checked ? { backgroundColor: t.inv, borderColor: t.inv } : { borderColor: t.tx3 },
                  ]}
                >
                  {row.checked ? <Icon name="check" size={14} color={t.invtx} /> : null}
                </View>
                <View style={styles.fill}>
                  <Text weight="medium">{label}</Text>
                  <Text variant="caption">
                    {`${toDisplayQty(Math.max(0, left), basis)} ${unit} pending`}
                    {l.reservedKg > 0 ? ` · ${toDisplayQty(l.reservedKg, basis)} on trucks` : ''}
                  </Text>
                  {over ? (
                    <Text variant="caption" color="wnt">
                      More than is left on this line. It will still be sent.
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              <TextInput
                {...inputTheme(t, scheme)}
                accessibilityLabel={`Planned ${unit}, ${label}`}
                value={row.qty}
                onChangeText={(qty) => onChange(l.id, { checked: qty.trim() !== '' || row.checked, qty })}
                placeholder="—"
                keyboardType="decimal-pad"
                style={[
                  styles.qty,
                  {
                    color: t.tx,
                    borderColor: over ? t.wn : t.bd2,
                    backgroundColor: t.card,
                    fontFamily: fontFamily.semibold,
                    fontSize: 15 * scale,
                  },
                ]}
              />
            </View>
          );
        })}
      </Group>
      {error ? (
        <Text variant="caption" color="dgt" accessibilityLiveRegion="polite" style={styles.label}>
          {error}
        </Text>
      ) : (
        <Text variant="caption" style={styles.label}>
          The plan guides loading. The dispatched quantity is the net weight.
        </Text>
      )}
    </View>
  );
}

/** Canvas `.chip`: a recent vehicle; fills vehicle, transporter and driver. */
export function RecentChip({ vehicleNo, onPress }: { vehicleNo: string; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Recent vehicle ${vehicleNo}`}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd }]}
    >
      <Text weight="medium" color="tx2" style={styles.smallText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {vehicleNo}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { minHeight: 34, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, justifyContent: 'center' },
  smallText: { fontSize: 13, lineHeight: 18 },
  field: { gap: 6 },
  label: { paddingHorizontal: 4 },
  fill: { flex: 1, minWidth: 0 },
  box: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16 },
  check: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: MIN_TOUCH + 4 },
  box20: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  qty: { width: 104, minHeight: MIN_TOUCH, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, textAlign: 'right' },
});
