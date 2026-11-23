import type { Tokens } from './tokens';

type Rgba = [r: number, g: number, b: number, a: number];

/** `#RGB`, `#RRGGBB` or `rgba(r,g,b,a)` / `rgb(r,g,b)`. */
export function parseColor(c: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (fn) {
    const [r, g, b, a = '1'] = fn[1]!.split(',').map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`Not a colour: ${c}`);
}

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG 2.1 contrast of `fg` on `bg`. Translucent colours are flattened: `bg` over `base` (the
 * surface under it, default `bg` itself must be opaque), then `fg` over that.
 */
export function contrastRatio(fg: string, bg: string, base?: string): number {
  const b0 = base ? parseColor(base) : ([255, 255, 255, 1] as Rgba);
  const back = over(parseColor(bg), b0);
  const front = over(parseColor(fg), back);
  const [l1, l2] = [luminance(front), luminance(back)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Text pairs the app uses (F5 Ruling 13): 4.5:1 for body text, 3:1 for large text and icons. */
export interface TextPair {
  fg: keyof Tokens;
  bg: keyof Tokens;
  /** The surface a translucent `bg` sits on. */
  on?: keyof Tokens;
  min: 4.5 | 3;
}

export const TEXT_PAIRS: readonly TextPair[] = [
  ...(['tx', 'tx2', 'tx3'] as const).flatMap((fg) => (['bg', 'card', 'ctl'] as const).map((bg) => ({ fg, bg, min: 4.5 as const }))),
  { fg: 'brt', bg: 'card', min: 4.5 },
  { fg: 'brt', bg: 'brs', on: 'card', min: 4.5 },
  { fg: 'okt', bg: 'card', min: 4.5 },
  { fg: 'okt', bg: 'oks', on: 'card', min: 4.5 },
  { fg: 'wnt', bg: 'card', min: 4.5 },
  { fg: 'wnt', bg: 'wns', on: 'card', min: 4.5 },
  { fg: 'dgt', bg: 'card', min: 4.5 },
  { fg: 'dgt', bg: 'dgs', on: 'card', min: 4.5 },
  { fg: 'vi', bg: 'card', min: 4.5 },
  { fg: 'vi', bg: 'vis', on: 'card', min: 4.5 },
  { fg: 'te', bg: 'card', min: 4.5 },
  { fg: 'te', bg: 'tes', on: 'card', min: 4.5 },
  { fg: 'invtx', bg: 'inv', min: 4.5 },
  { fg: 'invtx2', bg: 'inv', min: 4.5 },
  { fg: 'onDanger', bg: 'dgf', min: 4.5 },
  { fg: 'vitx', bg: 'vi', min: 4.5 },
  // WhatsApp button: white bold button text (large text, 3:1).
  { fg: 'invtx', bg: 'wa', min: 3 },
  // Icons and large figures.
  { fg: 'br', bg: 'card', min: 3 },
  { fg: 'ok', bg: 'card', min: 3 },
];
