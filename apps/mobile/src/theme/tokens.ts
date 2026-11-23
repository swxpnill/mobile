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
  /** Soft white on the primary fill (canvas board 39 lead tile: icon well, caption). */
  invsoft: string;
  invtx2: string;
  br: string;
  brt: string;
  brs: string;
  vi: string;
  vis: string;
  /** Text on a violet fill (canvas `.bv`): white in light, near-black in dark. */
  vitx: string;
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
  /** Tab bar surface (board 15: a shade below the page in Graphite). */
  tabBar: string;
  /** Dimmed backdrop behind sheets (board 39). */
  scrim: string;
  /** Shadow colour for raised controls (toast, segmented thumb, switch thumb). */
  shadow: string;
  /** Text and icons on the danger fill (`dgf`). */
  onDanger: string;
  /** WhatsApp action fill (Request vehicle, canvas 40); white bold text on it, 3:1. */
  wa: string;
  /** Switch knob. */
  thumb: string;
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
  invsoft: 'rgba(255,255,255,.18)',
  // was rgba(255,255,255,.8) (canvas board 39), raised for 4.5:1 on inv (F5 Ruling 13).
  invtx2: 'rgba(255,255,255,.92)',
  br: '#2563EB',
  brt: '#1D4ED8',
  brs: 'rgba(37,99,235,.10)',
  vi: '#5B3CC4',
  vis: 'rgba(109,74,224,.10)',
  vitx: '#FFFFFF',
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
  tabBar: '#FFFFFF',
  scrim: 'rgba(11,13,18,.42)',
  shadow: '#0B0D12',
  onDanger: '#FFFFFF',
  wa: '#128C4A',
  thumb: '#FFFFFF',
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
  // was #4F86F7 (canvas Graphite), darkened in hue for 4.5:1 with white text (F5 Ruling 13).
  inv: '#4473D4',
  invtx: '#FFFFFF',
  invsoft: 'rgba(255,255,255,.18)',
  // was rgba(255,255,255,.8): only full white reaches 4.5:1 on the dark inv (F5 Ruling 13).
  invtx2: '#FFFFFF',
  br: '#4F86F7',
  brt: '#8AB0FF',
  brs: 'rgba(79,134,247,.16)',
  vi: '#A994FF',
  vis: 'rgba(155,133,245,.16)',
  vitx: '#0D0D10',
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
  tabBar: '#0D0D10',
  scrim: 'rgba(0,0,0,.6)',
  shadow: '#000000',
  onDanger: '#FFFFFF',
  wa: '#1FA855',
  thumb: '#FFFFFF',
};

export type ColorScheme = 'light' | 'dark';

/** Company unit tags: four colour slots; a company takes slot = index in code-sorted list mod 4. */
const UNIT_TAG_SLOTS: { bg: keyof Tokens; light: string; dark: string }[] = [
  { bg: 'brs', light: '#1D4ED8', dark: '#8AB0FF' },
  { bg: 'vis', light: '#5B3CC4', dark: '#A994FF' },
  { bg: 'oks', light: '#067A6A', dark: '#3CC7B4' },
  { bg: 'wns', light: '#8F5E12', dark: '#E5A93B' },
];

/** Home's pending bar and legend, per unit slot (boards 02 light, 15 Graphite). */
const UNIT_BAR: Record<ColorScheme, readonly string[]> = {
  light: ['#2563EB', '#5B3CC4', '#089981', '#D18A12'],
  dark: ['#4F86F7', '#9B85F5', '#26A69A', '#E5A93B'],
};

export function unitBarColor(slot: number, scheme: ColorScheme): string {
  return UNIT_BAR[scheme][((slot % 4) + 4) % 4]!;
}

export function unitTagColors(slot: number, scheme: ColorScheme): { bg: string; fg: string } {
  const s = UNIT_TAG_SLOTS[((slot % 4) + 4) % 4]!;
  const t = scheme === 'dark' ? darkTokens : lightTokens;
  return { bg: t[s.bg], fg: s[scheme] };
}

export type TypeVariant =
  | 'title'
  | 'subtitle'
  | 'heading'
  | 'stat'
  | 'button'
  | 'body'
  | 'chip'
  | 'caption'
  | 'overline';

/** Canvas type scale. Letter spacing converted from em to px at each size. */
export const typeScale: Record<TypeVariant, TextStyle> = {
  title: { fontSize: 28, lineHeight: 34, letterSpacing: -0.7 },
  subtitle: { fontSize: 20, lineHeight: 26, letterSpacing: -0.4 },
  heading: { fontSize: 17, lineHeight: 24, letterSpacing: -0.255 },
  /** A figure in a stat tile (board 23 "962.400"). */
  stat: { fontSize: 18, lineHeight: 24 },
  /** Button label (canvas `.btn`). */
  button: { fontSize: 15, lineHeight: 20 },
  body: { fontSize: 14, lineHeight: 20 },
  /** Filter chip label (canvas `.flt`). */
  chip: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  overline: { fontSize: 11, lineHeight: 14, letterSpacing: 0.77, textTransform: 'uppercase' },
};

/** Default weight per variant (title/heading/overline are semibold in the canvas). */
export const variantWeight: Record<TypeVariant, FontWeight> = {
  title: 'semibold',
  subtitle: 'semibold',
  heading: 'semibold',
  stat: 'semibold',
  button: 'semibold',
  body: 'regular',
  chip: 'medium',
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
