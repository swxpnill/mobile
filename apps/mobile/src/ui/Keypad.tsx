import type { UnitBasis } from '@tonnage/shared';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, type Tokens } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/** Longest weight a keypad takes, decimal point included ("9999.999", "1234567"). */
export const KEYPAD_MAX_CHARS = 7;
/** MT has three decimals (kg); kg has none. */
const MAX_DECIMALS = 3;

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'del';

/** Weighbridge unit on the capture screens (canvas): "t" for MT, "kg" for kg. */
export function weightUnit(basis: UnitBasis): 't' | 'kg' {
  return basis === 'mt' ? 't' : 'kg';
}

/**
 * The keypad's typing rules (Review Focus 5): one decimal point and only in MT, at most three
 * decimals, at most 7 characters, no leading zeros. Returns the value unchanged when refused.
 */
export function pressKey(value: string, key: KeypadKey, basis: UnitBasis): string {
  if (key === 'del') return value.slice(0, -1);
  if (key === '.') {
    if (basis !== 'mt' || value.includes('.')) return value;
    const next = (value || '0') + '.';
    return next.length > KEYPAD_MAX_CHARS ? value : next;
  }
  if (value.length >= KEYPAD_MAX_CHARS) return value;
  const decimals = value.split('.')[1];
  if (decimals !== undefined && decimals.length >= MAX_DECIMALS) return value;
  return value === '0' ? key : value + key;
}

const ROWS: (KeypadKey | null)[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'del'],
];

/** Canvas weighbridge keypad: a 3×4 grid; the decimal key only in MT. */
export function Keypad({
  value,
  onChange,
  basis,
}: {
  value: string;
  onChange(v: string): void;
  basis: UnitBasis;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.grid}>
      {ROWS.map((row, r) => (
        <View key={r} style={styles.row}>
          {row.map((key, c) => {
            if (key === null || (key === '.' && basis !== 'mt'))
              return <View key={c} style={styles.cell} />;
            const label = key === 'del' ? 'Delete' : key === '.' ? 'Decimal point' : key;
            return (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={key === 'del' ? 'Hold to clear' : undefined}
                onPress={() => onChange(pressKey(value, key, basis))}
                onLongPress={key === 'del' ? () => onChange('') : undefined}
                style={({ pressed }) => [
                  styles.cell,
                  styles.key,
                  { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd },
                ]}
              >
                {key === 'del' ? (
                  <Icon name="backspace" size={24} color={t.tx} />
                ) : (
                  <Text weight="medium" style={styles.keyText}>
                    {key}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * The big number above the keypad (canvas 12 / 36): what was typed, in the user's basis, with
 * its unit. A polite live region, so a screen reader reads each change.
 */
export function WeightReadout({
  value,
  basis,
  color = 'tx',
  compact,
}: {
  value: string;
  basis: UnitBasis;
  color?: keyof Tokens;
  /** Smaller, for two readouts side by side (the owner's weight correction). */
  compact?: boolean;
}) {
  const shown = value || '0';
  const spoken = `${shown} ${basis === 'mt' ? 'tonnes' : 'kilograms'}`;
  return (
    <Text
      testID="weight-readout"
      accessibilityLiveRegion="polite"
      accessibilityLabel={spoken}
      numeric
      weight="semibold"
      color={color}
      style={compact ? styles.readoutCompact : styles.readout}
    >
      {shown}
      <Text weight="medium" color="tx3" style={compact ? styles.unitCompact : styles.unit}>
        {` ${weightUnit(basis)}`}
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, height: 58 },
  key: {
    borderRadius: radius.button,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: { fontSize: 24, lineHeight: 30 },
  readout: { fontSize: 56, lineHeight: 64, letterSpacing: -2, textAlign: 'center' },
  unit: { fontSize: 22, lineHeight: 28, letterSpacing: 0 },
  readoutCompact: { fontSize: 28, lineHeight: 34, letterSpacing: -0.5 },
  unitCompact: { fontSize: 15, lineHeight: 20, letterSpacing: 0 },
});
