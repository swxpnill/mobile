import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { dateLabel } from '../../format/time';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, radius } from '../../theme/tokens';
import { Button, CalendarSheet, Group, Icon, Text } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { type DateRange, PRESETS, type PresetKey, presetOf, presetRange, rangeLabel, rangeProblem } from './ranges';

/**
 * Ruling 9: Today · Yesterday · This month · Last month · This financial year · Custom. A preset
 * applies at once; Custom picks two dates and refuses a range the server would (checkRange).
 * Mounted while open, so each opening starts from the range in use.
 */
export function RangeSheet({
  value,
  today,
  onApply,
  onClose,
}: {
  value: DateRange;
  today: string;
  onApply(range: DateRange): void;
  onClose(): void;
}) {
  const [custom, setCustom] = useState(() => presetOf(value, today) === null);
  const [draft, setDraft] = useState<DateRange>(value);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const current = custom ? null : presetOf(value, today);
  const problem = rangeProblem(draft, today);

  const pickPreset = (key: PresetKey) => {
    onApply(presetRange(key, today));
    onClose();
  };

  return (
    <Sheet visible title="Date range" onClose={onClose}>
      <Group>
        {PRESETS.map((p) => (
          <Option
            key={p.key}
            label={p.label}
            detail={(() => {
              const r = presetRange(p.key, today);
              return rangeLabel(r.from, r.to);
            })()}
            checked={current === p.key}
            onPress={() => pickPreset(p.key)}
          />
        ))}
        <Option label="Custom" detail="Pick a start and end date" checked={custom} onPress={() => setCustom(true)} />
      </Group>

      {custom ? (
        <View style={styles.custom}>
          <View style={styles.fields}>
            <DateField label="From" iso={draft.from} onPress={() => setPicking('from')} />
            <DateField label="To" iso={draft.to} onPress={() => setPicking('to')} />
          </View>
          {/* One reserved line, so the button does not move when a problem shows. */}
          <Text variant="caption" color="dgt" accessibilityRole={problem ? 'alert' : undefined} style={styles.message}>
            {problem ?? ' '}
          </Text>
          <Button
            disabled={problem !== null}
            onPress={() => {
              onApply(draft);
              onClose();
            }}
          >
            Apply
          </Button>
        </View>
      ) : null}

      {picking ? (
        <CalendarSheet
          title={picking === 'from' ? 'Start date' : 'End date'}
          value={draft[picking]}
          max={today}
          onPick={(d) => {
            setDraft((r) => ({ ...r, [picking]: d }));
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </Sheet>
  );
}

function Option({ label, detail, checked, onPress }: { label: string; detail: string; checked: boolean; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${label}, ${detail}`}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed ? { backgroundColor: t.act } : null]}
    >
      <View style={styles.fill}>
        <Text weight="medium">{label}</Text>
        <Text variant="caption">{detail}</Text>
      </View>
      {checked ? <Icon name="check" size={20} color={t.brt} /> : null}
    </Pressable>
  );
}

function DateField({ label, iso, onPress }: { label: string; iso: string; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${dateLabel(iso)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.field, { backgroundColor: pressed ? t.act : t.ctl, borderColor: t.bd }]}
    >
      <Text variant="caption">{label}</Text>
      <View style={styles.fieldValue}>
        <Icon name="calendar" size={16} color={t.brt} />
        <Text weight="medium" numeric>
          {dateLabel(iso)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: MIN_TOUCH + 6,
  },
  custom: { marginTop: 14, gap: 8 },
  fields: { flexDirection: 'row', gap: 10 },
  field: { flex: 1, minHeight: 56, borderRadius: radius.input, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  fieldValue: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  message: { minHeight: 16 },
});
