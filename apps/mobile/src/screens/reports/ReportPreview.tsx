import { type Report, type ReportKind, type UnitBasis, groupIndian, toDisplayQty, unitLabel } from '@tonnage/shared';
import { memo, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { type Tokens, MIN_TOUCH, radius, unitTagColors } from '../../theme/tokens';
import { Button, Icon, type IconName, Text } from '../../ui';
import { messageFor } from '../messages';
import { AllRowsSheet, COLUMNS, CompanyRow, ListRow } from './ReportRows';
import { REPORT_META } from './reportMeta';
import { type Stat, reportView } from './reportView';

/** The file formats the export kit (Task 7) will build. */
export type ExportFormat = 'xlsx' | 'pdf';

/** How many rows the card lists before "See all N rows". */
export const PREVIEW_ROWS = 20;

/**
 * Board 23 preview card: title and range, three stats, then the per-company table (register,
 * unit sales) or the first rows (every other kind), and the Excel · PDF · Share buttons.
 * `onExport` is left out until the export kit exists: Excel and PDF then read "Coming soon".
 */
export function ReportPreview({
  kind,
  report,
  loading,
  error,
  stale,
  rangeText,
  basis,
  slotOf,
  onRetry,
  onShare,
  onExport,
  holdHeight,
  onMeasure,
}: {
  kind: ReportKind;
  report: Report | undefined;
  loading: boolean;
  error: unknown;
  /** The last report of this kind, shown while the next range or filter loads. */
  stale: boolean;
  rangeText: string;
  basis: UnitBasis;
  slotOf(companyCode: string): number;
  onRetry(): void;
  onShare(): void;
  onExport?: (format: ExportFormat) => void;
  /**
   * The card's height when the last report was on screen. Until this kind's report arrives the
   * card keeps at least that height, so the page under the user's finger does not shrink and
   * scroll (switching a lower tile used to jump the page).
   */
  holdHeight?: number;
  /** Reports the card's height once a report is shown. */
  onMeasure?: (height: number) => void;
}) {
  const { t, scheme } = useTheme();
  const meta = REPORT_META[kind];
  const data = report?.kind === kind ? report : undefined;
  const view = useMemo(() => (data ? reportView(data, basis) : null), [data, basis]);
  const [all, setAll] = useState(false);
  const empty = data !== undefined && data.rows.length === 0;
  const colorOf = (code: string) => unitTagColors(slotOf(code), scheme).fg;

  let body;
  if (!data && loading) {
    body = (
      <View style={styles.state}>
        <ActivityIndicator color={t.br} accessibilityLabel={`Loading ${meta.title}`} />
      </View>
    );
  } else if (!data) {
    body = (
      <View style={[styles.state, styles.gap]}>
        <Text color="tx2" accessibilityRole="alert" style={styles.center}>
          {error ? messageFor(error) : meta.emptyText}
        </Text>
        <Button variant="secondary" onPress={onRetry}>
          Try again
        </Button>
      </View>
    );
  } else if (empty) {
    body = (
      <View style={styles.state}>
        <Text color="tx2" style={styles.center}>
          {meta.emptyText}
        </Text>
      </View>
    );
  } else if (view?.table) {
    const { table } = view;
    body = (
      <View>
        <View style={[styles.tr, { backgroundColor: t.bg, borderTopColor: t.bd }]}>
          <Text variant="overline" style={{ flex: COLUMNS.unit }}>
            Unit
          </Text>
          <Text variant="overline" style={[styles.right, { flex: COLUMNS.net }]}>
            {`Net ${unitLabel(basis)}`}
          </Text>
          <Text variant="overline" style={[styles.right, { flex: COLUMNS.trucks }]}>
            Trucks
          </Text>
        </View>
        {table.lines.map((l) => (
          <CompanyRow key={l.key} line={l} color={colorOf(l.code)} basis={basis} />
        ))}
        <View style={[styles.tr, { backgroundColor: t.bg, borderTopColor: t.bd }]}>
          <Text weight="semibold" style={{ flex: COLUMNS.unit }}>
            Total
          </Text>
          <Text weight="semibold" numeric color="okt" style={[styles.right, { flex: COLUMNS.net }]}>
            {toDisplayQty(table.netKg, basis)}
          </Text>
          <Text weight="semibold" numeric style={[styles.right, { flex: COLUMNS.trucks }]}>
            {groupIndian(String(table.trucks))}
          </Text>
        </View>
      </View>
    );
  } else if (view) {
    const more = view.list.length > PREVIEW_ROWS;
    body = (
      <View>
        {view.list.slice(0, PREVIEW_ROWS).map((l) => (
          <ListRow key={l.key} line={l} />
        ))}
        {more ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setAll(true)}
            style={({ pressed }) => [styles.more, { borderTopColor: t.bd }, pressed ? { backgroundColor: t.act } : null]}
          >
            <Text weight="medium" color="brt">
              {`See all ${groupIndian(String(view.list.length))} rows`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const exportDisabled = !onExport || !data || empty;
  const exportHint = onExport ? undefined : 'Coming soon';

  return (
    <>
      <View
        testID="report-preview"
        style={[
          styles.card,
          { backgroundColor: t.card, borderColor: t.bd },
          !data && holdHeight ? { minHeight: holdHeight } : null,
          stale ? styles.stale : null,
        ]}
        onLayout={(e) => {
          if (data) onMeasure?.(Math.round(e.nativeEvent.layout.height));
        }}
      >
        <View style={styles.top}>
          <View style={styles.head}>
            <Text variant="heading" accessibilityRole="header" style={styles.fill}>
              {meta.title}
            </Text>
            <Text variant="caption">{rangeText}</Text>
          </View>
          <View style={styles.stats}>
            {(view?.stats ?? PLACEHOLDER_STATS).map((s, i) => (
              <StatCell key={i} s={s} />
            ))}
          </View>
          {view?.table && !empty ? (
            <View style={styles.bar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {view.table.lines.map((l) => (
                <View key={l.key} style={[styles.seg, { flex: Math.max(l.netKg, 1), backgroundColor: colorOf(l.code) }]} />
              ))}
            </View>
          ) : null}
        </View>
        {body}
        {data?.truncated ? (
          <Text variant="caption" color="wnt" style={[styles.note, { borderTopColor: t.bd }]}>
            Showing the first 5,000 rows; narrow the range
          </Text>
        ) : null}
      </View>

      <View style={styles.buttons}>
        <ActionButton
          label="Excel"
          icon="fileGrid"
          bg="oks"
          fg="okt"
          disabled={exportDisabled}
          hint={exportHint}
          onPress={() => onExport?.('xlsx')}
        />
        <ActionButton
          label="PDF"
          icon="fileBlank"
          bg="dgs"
          fg="dgt"
          disabled={exportDisabled}
          hint={exportHint}
          onPress={() => onExport?.('pdf')}
        />
        <ActionButton label="Share" icon="message" bg="brs" fg="brt" disabled={!data || empty} onPress={onShare} />
      </View>

      {all && view ? <AllRowsSheet title={meta.title} lines={view.list} onClose={() => setAll(false)} /> : null}
    </>
  );
}

const PLACEHOLDER_STATS: Stat[] = [
  { label: ' ', value: '—', caption: ' ', color: 'tx3' },
  { label: ' ', value: '—', caption: ' ', color: 'tx3' },
  { label: ' ', value: '—', caption: ' ', color: 'tx3' },
];

const StatCell = memo(function StatCell({ s }: { s: Stat }) {
  return (
    <View style={styles.fill} accessible accessibilityLabel={`${s.label} ${s.value} ${s.caption}`}>
      <Text variant="caption">{s.label}</Text>
      <Text variant="stat" numeric color={s.color} numberOfLines={1} adjustsFontSizeToFit>
        {s.value}
      </Text>
      <Text variant="caption" numberOfLines={1}>
        {s.caption}
      </Text>
    </View>
  );
});

const ActionButton = memo(function ActionButton({
  label,
  icon,
  bg,
  fg,
  disabled,
  hint,
  onPress,
}: {
  label: string;
  icon: IconName;
  bg: keyof Tokens;
  fg: keyof Tokens;
  disabled: boolean;
  hint?: string;
  onPress(): void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: t[bg] },
        disabled ? styles.disabled : pressed ? styles.pressed : null,
      ]}
    >
      <Icon name={icon} size={18} color={t[fg]} />
      <Text variant="button" numberOfLines={1} color={fg}>
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  gap: { gap: 12 },
  center: { textAlign: 'center' },
  card: { borderRadius: radius.group, borderWidth: 1, overflow: 'hidden' },
  stale: { opacity: 0.6 },
  top: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  stats: { flexDirection: 'row', gap: 10 },
  bar: { flexDirection: 'row', gap: 3, height: 8, marginTop: 4, borderRadius: 4, overflow: 'hidden' },
  seg: { borderRadius: 2 },
  // Loading, error and empty share one height, so switching kinds does not jump the page.
  state: { minHeight: 132, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 16 },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: 1 },
  right: { textAlign: 'right' },
  more: { minHeight: MIN_TOUCH + 4, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1 },
  note: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1 },
  buttons: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    height: 52,
    borderRadius: radius.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
});
