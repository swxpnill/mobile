// Colours a rendered tree uses, and the palette it may use (dark-theme checks).
import { StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { type ColorScheme, darkTokens, lightTokens, unitBarColor, unitTagColors } from '../src/theme/tokens';

/** Every colour the palette may paint with, for one scheme. */
export function palette(scheme: ColorScheme): Set<string> {
  const t = scheme === 'dark' ? darkTokens : lightTokens;
  const out = new Set<string>([...Object.values(t), 'transparent', 'none', 'currentColor']);
  for (let slot = 0; slot < 4; slot++) {
    const c = unitTagColors(slot, scheme);
    out.add(c.bg).add(c.fg).add(unitBarColor(slot, scheme));
  }
  return out;
}

const COLOR_KEYS = ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor', 'shadowColor', 'tintColor', 'textShadowColor'];
const PROP_KEYS = ['color', 'stroke', 'fill', 'placeholderTextColor', 'selectionColor', 'tintColor', 'trackColor', 'thumbColor'];

/** Colours used anywhere in the rendered tree, with where they were found. */
export function collectColors(node: ReactTestRendererJSON | ReactTestRendererJSON[] | null, out = new Map<string, string>()): Map<string, string> {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectColors(n, out);
    return out;
  }
  const props = node.props as Record<string, unknown>;
  const style = StyleSheet.flatten(props.style as never) as Record<string, unknown> | undefined;
  for (const k of COLOR_KEYS) if (typeof style?.[k] === 'string') out.set(style[k] as string, `${node.type}.style.${k}`);
  for (const k of PROP_KEYS) if (typeof props[k] === 'string') out.set(props[k] as string, `${node.type}.${k}`);
  for (const child of node.children ?? []) if (typeof child !== 'string') collectColors(child, out);
  return out;
}
