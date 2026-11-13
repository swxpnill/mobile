import type { TextStyle } from 'react-native';

/**
 * Colour tokens, exactly as defined in the design canvas (light, and "Graphite" dark).
 * Names follow the canvas CSS variables: bg/card/ctl/act surfaces, bd/bd2 borders, tx/tx2/tx3 text,
 * inv = primary fill, and per hue a solid (br, vi, ok, wn, dg, te), a text tint (…t) and a soft
 * background (…s).
 */
export interface Tokens {
  bg: string;
  card: string;
  ctl: string;
  act: string;
  bd: string;
  bd2: string;
  tx: string;
  tx2: string;
  tx3: string;
  inv: string;
  invtx: string;
  br: string;
  brt: string;
  brs: string;
  vi: string;
  vis: string;
  ok: string;
  okt: string;
  oks: string;
  wn: string;
  wnt: string;
  wns: string;
  dg: string;
  dgt: string;
  dgs: string;
  /** Danger button fill: passes 4.5:1 with white text in both themes. */
  dgf: string;
  te: string;
  tes: string;
}

export const lightTokens: Tokens = {
  bg: '#F4F5F7',
  card: '#FFFFFF',
  ctl: '#EEEFF2',
  act: '#E4E6EA',
  bd: 'rgba(11,13,18,.08)',
  bd2: 'rgba(11,13,18,.14)',
  tx: '#0F1115',
  tx2: '#4B505A',
  tx3: '#626771',
  inv: '#2563EB',
  invtx: '#FFFFFF',
  br: '#2563EB',
  brt: '#1D4ED8',
  brs: 'rgba(37,99,235,.10)',
  vi: '#5B3CC4',
  vis: 'rgba(109,74,224,.10)',
  ok: '#089981',
  okt: '#067A6A',
  oks: 'rgba(8,153,129,.11)',
  wn: '#D18A12',
  wnt: '#8F5E12',
  wns: 'rgba(183,121,31,.13)',
  dg: '#E11D2E',
  dgt: '#D21E2B',
  dgs: 'rgba(242,54,69,.09)',
  dgf: '#D21E2B',
  te: '#0E7490',
  tes: 'rgba(14,116,144,.10)',
};

export const darkTokens: Tokens = {
  bg: '#09090B',
  card: '#111114',
  ctl: '#18181C',
  act: '#25252B',
  bd: 'rgba(255,255,255,.06)',
  bd2: 'rgba(255,255,255,.10)',
  tx: '#F4F3EF',
  tx2: '#A3A3A9',
  tx3: '#85858D',
  inv: '#4F86F7',
  invtx: '#FFFFFF',
  br: '#4F86F7',
  brt: '#8AB0FF',
  brs: 'rgba(79,134,247,.16)',
  vi: '#A994FF',
  vis: 'rgba(155,133,245,.16)',
  ok: '#26A69A',
  okt: '#26A69A',
  oks: 'rgba(38,166,154,.14)',
  wn: '#E5A93B',
  wnt: '#E5A93B',
  wns: 'rgba(229,169,59,.14)',
  dg: '#EF5350',
  dgt: '#EF5350',
  dgs: 'rgba(239,83,80,.14)',
  dgf: '#C62828',
  te: '#3CC7D9',
  tes: 'rgba(60,199,217,.14)',
};

export type ColorScheme = 'light' | 'dark';

/** Company unit tags: four colour slots; a company takes slot = index in code-sorted list mod 4. */
const UNIT_TAG_SLOTS: { bg: keyof Tokens; light: string; dark: string }[] = [
  { bg: 'brs', light: '#1D4ED8', dark: '#8AB0FF' },
  { bg: 'vis', light: '#5B3CC4', dark: '#A994FF' },
  { bg: 'oks', light: '#067A6A', dark: '#3CC7B4' },
  { bg: 'wns', light: '#8F5E12', dark: '#E5A93B' },
];

export function unitTagColors(slot: number, scheme: ColorScheme): { bg: string; fg: string } {
  const s = UNIT_TAG_SLOTS[((slot % 4) + 4) % 4]!;
  const t = scheme === 'dark' ? darkTokens : lightTokens;
  return { bg: t[s.bg], fg: s[scheme] };
}

export type TypeVariant = 'title' | 'subtitle' | 'heading' | 'body' | 'caption' | 'overline';

/** Canvas type scale. Letter spacing converted from em to px at each size. */
export const typeScale: Record<TypeVariant, TextStyle> = {
  title: { fontSize: 28, lineHeight: 34, letterSpacing: -0.7 },
  subtitle: { fontSize: 20, lineHeight: 26, letterSpacing: -0.4 },
  heading: { fontSize: 17, lineHeight: 24, letterSpacing: -0.255 },
  body: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 16 },
  overline: { fontSize: 11, lineHeight: 14, letterSpacing: 0.77, textTransform: 'uppercase' },
};

/** Default weight per variant (title/heading/overline are semibold in the canvas). */
export const variantWeight: Record<TypeVariant, FontWeight> = {
  title: 'semibold',
  subtitle: 'semibold',
  heading: 'semibold',
  body: 'regular',
  caption: 'regular',
  overline: 'semibold',
};

export type FontWeight = 'regular' | 'medium' | 'semibold';

/** Inter is loaded per weight; Android needs the family name, not fontWeight, to pick it. */
export const fontFamily: Record<FontWeight, string> = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
};

export const radius = { group: 16, button: 14, chip: 18, badge: 6, control: 10, tag: 5, input: 12 } as const;

/**
 * Cap on the phone font-size multiplier for text inside small pills (badge, unit tag, chip, compact
 * segment). Body text still scales freely.
 */
export const SMALL_TEXT_MAX_SCALE = 1.3;

/** Minimum touch target (Android/Material and WCAG 2.5.5 guidance). */
export const MIN_TOUCH = 44;
