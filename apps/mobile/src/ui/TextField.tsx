import { type ComponentRef, forwardRef, useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { fontFamily } from '../theme/tokens';
import { Text } from './Text';

export interface TextFieldProps extends Omit<
  TextInputProps,
  'style' | 'onChangeText' | 'value' | 'placeholderTextColor'
> {
  /** Shown above the field and used as the accessible name. */
  label: string;
  /** Hide the visible label (still announced) — e.g. when the screen title already says it. */
  hideLabel?: boolean;
  value: string;
  onChangeText(text: string): void;
  /** Fixed text before the input, e.g. "+91". */
  prefix?: string;
  /** Help text under the field; replaced by `error` when there is one. */
  hint?: string;
  error?: string;
}

/** Canvas `.inp`: 48 high, radius 12, card fill, 1 px bd2 border; focus ring like the OTP boxes. */
export const TextField = forwardRef<ComponentRef<typeof TextInput>, TextFieldProps>(
  function TextField(
    { label, hideLabel, value, onChangeText, prefix, hint, error, onFocus, onBlur, ...input },
    ref,
  ) {
    const { t, scale } = useTheme();
    const [focused, setFocused] = useState(false);
    const border = error ? t.dgt : focused ? t.br : t.bd2;
    return (
      <View style={styles.wrap}>
        {hideLabel ? null : (
          <Text variant="caption" weight="medium" color="tx2" style={styles.label}>
            {label}
          </Text>
        )}
        <View>
          {focused ? <View style={[styles.ring, { backgroundColor: t.brs }]} /> : null}
          <View
            testID="textfield-box"
            style={[
              styles.box,
              {
                backgroundColor: t.card,
                borderColor: border,
                borderWidth: focused || error ? 1.5 : 1,
              },
            ]}
          >
            {prefix ? (
              <Text weight="medium" color="tx2" style={{ fontSize: 15 }}>
                {prefix}
              </Text>
            ) : null}
            <TextInput
              ref={ref}
              {...input}
              accessibilityLabel={label}
              accessibilityHint={error ?? hint}
              value={value}
              onChangeText={onChangeText}
              placeholderTextColor={t.tx3}
              onFocus={(e) => {
                setFocused(true);
                onFocus?.(e);
              }}
              onBlur={(e) => {
                setFocused(false);
                onBlur?.(e);
              }}
              style={[
                styles.input,
                { color: t.tx, fontFamily: fontFamily.regular, fontSize: 15 * scale },
              ]}
            />
          </View>
        </View>
        {error ? (
          <Text variant="caption" color="dgt" accessibilityLiveRegion="polite" style={styles.help}>
            {error}
          </Text>
        ) : hint ? (
          <Text variant="caption" style={styles.help}>
            {hint}
          </Text>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { paddingHorizontal: 4 },
  box: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  ring: { position: 'absolute', top: -4, bottom: -4, left: -4, right: -4, borderRadius: 16 },
  input: { flex: 1, paddingVertical: 12, minHeight: 46 },
  help: { paddingHorizontal: 4 },
});
