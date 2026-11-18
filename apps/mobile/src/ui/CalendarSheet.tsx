import { memo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { dateLabel, monthLabel } from '../format/time';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH, SMALL_TEXT_MAX_SCALE } from '../theme/tokens';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Text } from './Text';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * One month as a Sunday-first grid: `null` for the blanks before the 1st, then each day as
 * `YYYY-MM-DD`. Pure calendar arithmetic on dates, so no time zone enters it.
 */
export function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(`${year}-${pad(month)}-${pad(d)}`);
  return cells;
}

const ym = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) });
const shift = (v: { year: number; month: number }, by: number) => {
  const i = v.year * 12 + (v.month - 1) + by;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
};
const monthKey = (v: { year: number; month: number }) => `${v.year}-${pad(v.month)}`;

/**
 * Pure-JS date picker (Ruling 10): a month grid of IST calendar dates; days after `max` (and
 * before `min`, when given) cannot be picked. No native picker, so Expo Go stays untouched.
 */
export function CalendarSheet({
  value,
  max,
  min,
  title = 'Pick a date',
  onPick,
  onClose,
}: {
  value: string;
  max: string;
  min?: string;
  title?: string;
  onPick(date: string): void;
  onClose(): void;
}) {
  const { t } = useTheme();
  const [shown, setShown] = useState(() => ym(value));
  const prev = shift(shown, -1);
  const next = shift(shown, 1);
  const canPrev = min === undefined || monthKey(prev) >= min.slice(0, 7);
  const canNext = monthKey(next) <= max.slice(0, 7);
  const cells = monthGrid(shown.year, shown.month);

  return (
    <Sheet visible title={title} onClose={onClose}>
      <View style={styles.head}>
        <NavButton icon="back" label="Previous month" disabled={!canPrev} onPress={() => setShown(prev)} />
        <Text weight="semibold" style={styles.month} accessibilityRole="header">
          {monthLabel(shown.year, shown.month)}
        </Text>
        <NavButton icon="chevronRight" label="Next month" disabled={!canNext} onPress={() => setShown(next)} />
      </View>
      <View style={styles.grid}>
        {WEEKDAYS.map((d, i) => (
          <View key={WEEKDAY_NAMES[i]} style={styles.cell} accessibilityLabel={WEEKDAY_NAMES[i]}>
            <Text variant="caption" weight="medium" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {d}
            </Text>
          </View>
        ))}
        {cells.map((iso, i) =>
          iso === null ? (
            <View key={`blank-${i}`} style={styles.cell} />
          ) : (
            <Day
              key={iso}
              iso={iso}
              selected={iso === value}
              disabled={iso > max || (min !== undefined && iso < min)}
              onPick={onPick}
              selectedBg={t.inv}
            />
          ),
        )}
      </View>
    </Sheet>
  );
}

function NavButton({ icon, label, disabled, onPress }: { icon: 'back' | 'chevronRight'; label: string; disabled: boolean; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.nav, { backgroundColor: pressed ? t.act : t.ctl, opacity: disabled ? 0.4 : 1 }]}
    >
      <Icon name={icon} size={18} color={t.tx2} />
    </Pressable>
  );
}

const Day = memo(function Day({
  iso,
  selected,
  disabled,
  onPick,
  selectedBg,
}: {
  iso: string;
  selected: boolean;
  disabled: boolean;
  onPick(date: string): void;
  selectedBg: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dateLabel(iso)}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={() => onPick(iso)}
      style={({ pressed }) => [
        styles.cell,
        styles.day,
        selected ? { backgroundColor: selectedBg } : pressed ? { backgroundColor: t.act } : null,
      ]}
    >
      <Text
        numeric
        weight={selected ? 'semibold' : 'regular'}
        color={selected ? 'invtx' : disabled ? 'tx3' : 'tx'}
        style={disabled ? styles.off : null}
        maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
      >
        {String(Number(iso.slice(8, 10)))}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  month: { flex: 1, textAlign: 'center' },
  nav: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  day: { borderRadius: 12 },
  off: { opacity: 0.5 },
});
