import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

export type ProgressTone = 'bar' | 'ok' | 'muted';

/**
 * Thin dispatched-of-ordered bar (canvas `.bar`). `value` is 0–1 and clamped; a tiny non-zero
 * stub is always drawn so an untouched line still reads as a bar, as on the canvas.
 */
export function ProgressBar({
  value,
  tone = 'bar',
  height = 4,
  label,
}: {
  value: number;
  tone?: ProgressTone;
  height?: number;
  /** Spoken as "<label>, 60 %"; without it the bar is hidden from screen readers. */
  label?: string;
}) {
  const { t } = useTheme();
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const pct = Math.round(v * 100);
  // Canvas --bar is the ok green in both themes.
  const fill = tone === 'muted' ? t.tx3 : t.ok;
  return (
    <View
      style={[styles.track, { height, borderRadius: height / 2, backgroundColor: t.act }]}
      accessible={label !== undefined}
      accessibilityLabel={label !== undefined ? `${label}, ${pct} %` : undefined}
      accessibilityRole={label !== undefined ? 'progressbar' : undefined}
      importantForAccessibility={label !== undefined ? 'yes' : 'no-hide-descendants'}
    >
      <View style={{ width: `${Math.max(pct, 1)}%`, height: '100%', borderRadius: height / 2, backgroundColor: fill }} />
    </View>
  );
}

const styles = StyleSheet.create({ track: { overflow: 'hidden', width: '100%' } });
