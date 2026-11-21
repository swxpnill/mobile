// F5 Task 9: the palette's text pairs pass WCAG 2.1 AA in both themes.
import { TEXT_PAIRS, contrastRatio } from '../src/theme/contrast';
import { type ColorScheme, darkTokens, lightTokens, unitTagColors } from '../src/theme/tokens';

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
  });

  it('flattens translucent colours over the surface under them', () => {
    // 50 % black over white is mid grey.
    expect(contrastRatio('rgba(0,0,0,.5)', '#FFFFFF')).toBeCloseTo(contrastRatio('#808080', '#FFFFFF'), 1);
  });
});

describe.each(['light', 'dark'] as const)('%s palette', (scheme: ColorScheme) => {
  const t = scheme === 'light' ? lightTokens : darkTokens;
  const rows = TEXT_PAIRS.map((p) => {
    const ratio = contrastRatio(t[p.fg], t[p.bg], p.on ? t[p.on] : undefined);
    return { pair: `${p.fg} on ${p.bg}${p.on ? ` (over ${p.on})` : ''}`, ratio: Math.round(ratio * 100) / 100, min: p.min };
  });

  it('every text pair meets its minimum', () => {
    expect(rows.filter((r) => r.ratio < r.min)).toEqual([]);
  });

  it('unit tags are readable (4.5:1 on their tint, over a card)', () => {
    const fails = [0, 1, 2, 3]
      .map((slot) => ({ slot, ...unitTagColors(slot, scheme) }))
      .map((c) => ({ slot: c.slot, ratio: Math.round(contrastRatio(c.fg, c.bg, t.card) * 100) / 100 }))
      .filter((r) => r.ratio < 4.5);
    expect(fails).toEqual([]);
  });
});
