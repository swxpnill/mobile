import { Text as RNText, type TextProps as RNTextProps, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import {
  type FontWeight,
  fontFamily,
  type Tokens,
  typeScale,
  type TypeVariant,
  variantWeight,
} from '../theme/tokens';

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  weight?: FontWeight;
  /** A token name (`tx2`, `okt`, …). Default: `tx`, or `tx3` for caption and overline. */
  color?: keyof Tokens;
  /** Tabular figures, so columns of numbers line up. */
  numeric?: boolean;
}

/** All app text. Applies the canvas type scale, Inter weights and the "Large text" multiplier. */
export function Text({ variant = 'body', weight, color, numeric, style, ...rest }: TextProps) {
  const { t, scale } = useTheme();
  const base = typeScale[variant];
  const fallbackColor: keyof Tokens =
    variant === 'caption' || variant === 'overline' ? 'tx3' : 'tx';
  // A caller may set its own size (button 15, chip 13); "Large text" must scale that too.
  const own = StyleSheet.flatten(style) ?? {};
  const fontSize = own.fontSize ?? base.fontSize ?? 14;
  const lineHeight =
    own.lineHeight ??
    (own.fontSize !== undefined ? Math.round(own.fontSize * 1.35) : (base.lineHeight ?? 20));
  return (
    <RNText
      {...rest}
      style={[
        base,
        {
          fontFamily: fontFamily[weight ?? variantWeight[variant]],
          color: t[color ?? fallbackColor],
        },
        numeric ? { fontVariant: ['tabular-nums'] } : null,
        style,
        { fontSize: fontSize * scale, lineHeight: lineHeight * scale },
      ]}
    />
  );
}
