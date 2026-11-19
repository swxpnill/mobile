import type { TextInputProps } from 'react-native';
import type { ColorScheme, Tokens } from '../theme/tokens';

/** Every text input's colours: placeholder, cursor and selection, and the keyboard's theme (iOS). */
export function inputTheme(t: Tokens, scheme: ColorScheme): Pick<TextInputProps, 'placeholderTextColor' | 'selectionColor' | 'keyboardAppearance'> {
  return { placeholderTextColor: t.tx3, selectionColor: t.br, keyboardAppearance: scheme };
}
