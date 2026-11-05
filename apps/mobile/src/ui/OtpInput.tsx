import { type ComponentRef, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

export interface OtpInputProps {
  length?: number;
  value: string;
  onChange(value: string): void;
  autoFocus?: boolean;
  /** Draws the boxes in the danger colour (wrong code). */
  invalid?: boolean;
  /** False while the code is being checked. */
  editable?: boolean;
}

/** Keeps digits only, at most `length` of them — typing, paste and SMS autofill all go through it. */
export function sanitizeOtp(raw: string, length: number): string {
  return raw.replace(/\D/g, '').slice(0, length);
}

/**
 * One real text field drawn as six boxes. A single field (rather than six) is what makes paste,
 * Android SMS autofill and screen readers work.
 */
export function OtpInput({
  length = 6,
  value,
  onChange,
  autoFocus,
  invalid,
  editable = true,
}: OtpInputProps) {
  const { t } = useTheme();
  const ref = useRef<ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(Boolean(autoFocus));
  const active = Math.min(value.length, length - 1);

  return (
    <Pressable onPress={() => ref.current?.focus()} style={styles.row} accessible={false}>
      {Array.from({ length }, (_, i) => {
        const isActive = focused && i === active;
        return (
          <View key={i} style={styles.slot} importantForAccessibility="no-hide-descendants">
            {isActive ? <View style={[styles.ring, { backgroundColor: t.brs }]} /> : null}
            <View
              testID={`otp-cell-${i}`}
              style={[
                styles.cell,
                {
                  backgroundColor: t.card,
                  borderColor: invalid ? t.dgt : isActive ? t.br : t.bd2,
                  borderWidth: isActive || invalid ? 1.5 : 1,
                },
              ]}
            >
              <Text variant="subtitle" numeric maxFontSizeMultiplier={1.5} style={{ fontSize: 24 }}>
                {value[i] ?? ''}
              </Text>
            </View>
          </View>
        );
      })}
      <TextInput
        ref={ref}
        accessibilityLabel="One-time code"
        value={value}
        onChangeText={(raw) => onChange(sanitizeOtp(raw, length))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        autoFocus={autoFocus}
        editable={editable}
        accessibilityHint={`${length} digits`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        caretHidden
        // The cursor always stays after the last digit: a tap on an early box cannot insert there.
        selection={{ start: value.length, end: value.length }}
        style={styles.hidden}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  // Boxes shrink on narrow phones (6 × 52 + gaps is wider than a 360 dp screen's content area).
  slot: { flex: 1, maxWidth: 52, height: 60 },
  cell: { flex: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: -4, bottom: -4, left: -4, right: -4, borderRadius: 18 },
  // Covers the boxes so a tap anywhere focuses it; invisible but still on screen for autofill.
  hidden: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.011,
    color: 'transparent',
  },
});
