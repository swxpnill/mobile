import { type Report, type ReportKind, istDateOf } from '@tonnage/shared';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Share, StyleSheet, View } from 'react-native';
import { byCode, useCompanies, usePlants } from '../../api/hooks/companies';
import { useParties } from '../../api/hooks/masters';
import { useDisplayBasis } from '../../api/hooks/me';
import { type ReportParams, useReport } from '../../api/hooks/reports';
import { dateLabel } from '../../format/time';
import { shortCompanyName } from '../../nav/roles';
import { useUnitFilter } from '../../prefs/unitFilter';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, SMALL_TEXT_MAX_SCALE } from '../../theme/tokens';
import { Icon, type IconName, Screen, Text } from '../../ui';
import { BackHeader } from '../admin/parts';
import { UnitSwitcherSheet } from '../UnitSwitcherSheet';
import { FilterSheet, type FilterOption } from './FilterSheet';
import { RangeSheet } from './RangeSheet';
import { ReportPreview } from './ReportPreview';
import { ReportTiles } from './ReportTiles';
import { FILTER_ALL, FILTER_PARAM, REPORT_META, type ReportFilterKey } from './reportMeta';
import { type DateRange, presetRange, rangeLabel } from './ranges';
import { shareSummary } from './reportView';
import { TourTarget } from '../../onboarding/TourTarget';

const FILTER_TITLE: Record<ReportFilterKey, string> = {
  customer: 'Customer',
  broker: 'Broker',
  plant: 'Plant',
  bucket: 'Age',
};

/** Board 23: pick a report, range, unit and the report's own filter; preview, then share. */
export function ReportsScreen() {
  const basis = useDisplayBasis();
  const today = istDateOf(Date.now());
  const [kind, setKind] = useState<ReportKind>('dispatch-register');
  const [range, setRange] = useState<DateRange>(() => presetRange('thisMonth', today));
  // The label is kept with the id, so the chip still names the pick while its options reload.
  const [picked, setPicked] = useState<Partial<Record<ReportFilterKey, FilterOption>>>({});
  const [sheet, setSheet] = useState<'range' | 'unit' | 'filter' | null>(null);
  // The preview's last loaded height, held while the next kind loads (stable scroll).
  const [previewHeight, setPreviewHeight] = useState(0);
  const unit = useUnitFilter();
  const { data: companies } = useCompanies();
  const meta = REPORT_META[kind];
  const filter = meta.filter;

  const all = useMemo(() => byCode(companies ?? []), [companies]);
  const chosen = meta.byCompany ? all.find((c) => c.id === unit.companyId) : undefined;
  const slotOf = useCallback((code: string) => Math.max(0, all.findIndex((c) => c.code === code)), [all]);

  const params: ReportParams = { ...range, companyId: chosen?.id };
  const pick = filter ? picked[filter] : undefined;
  if (filter && pick) params[FILTER_PARAM[filter]] = pick.id;
  const report = useReport(kind, params);
  const options = useFilterOptions(filter, report.data);

  const rangeChip = rangeLabel(range.from, range.to);
  const filterLabel = filter ? (pick?.label ?? FILTER_ALL[filter]) : null;

  const onShare = useCallback(() => {
    const r = report.data;
    if (!r || r.kind !== kind) return;
    const message = shareSummary(r, basis, {
      range: meta.ranged ? rangeChip : `As of ${dateLabel(today)}`,
      unitCode: chosen?.code,
    });
    void Share.share({ message, title: meta.title }).catch(() => undefined);
  }, [report.data, kind, basis, meta, rangeChip, today, chosen]);

  return (
    <Screen
      title="Reports"
      header={<BackHeader />}
      refresh={{ refreshing: report.isRefetching && !report.isPlaceholderData, onRefresh: () => void report.refetch() }}
    >
      <View style={styles.chips}>
        {meta.ranged ? (
          <FilterChip icon="calendar" label={rangeChip} name="Date range" onPress={() => setSheet('range')} />
        ) : (
          <FilterChip icon="clock" label="As of now" name="Range" />
        )}
        {meta.byCompany ? (
          <FilterChip
            icon="factory"
            label={chosen ? `${shortCompanyName(chosen.name)} · ${chosen.code}` : 'All units'}
            name="Unit"
            onPress={() => setSheet('unit')}
          />
        ) : (
          <FilterChip icon="factory" label="All units" name="Unit" hint="This report covers every unit" />
        )}
        {filter && filterLabel ? (
          <FilterChip icon="sliders" label={filterLabel} name="Filter" onPress={() => setSheet('filter')} />
        ) : null}
      </View>

      <TourTarget id="reports.firstTile">
        <ReportTiles selected={kind} onSelect={setKind} />
      </TourTarget>

      <ReportPreview
        key={kind}
        kind={kind}
        report={report.data}
        loading={report.isPending || report.isFetching}
        error={report.error}
        stale={report.isPlaceholderData}
        rangeText={meta.ranged ? rangeLabel(range.from, range.to, { year: false }) : 'As of now'}
        basis={basis}
        slotOf={slotOf}
        onRetry={() => void report.refetch()}
        onShare={onShare}
        holdHeight={previewHeight}
        onMeasure={setPreviewHeight}
      />

      {sheet === 'range' ? (
        <RangeSheet value={range} today={today} onApply={setRange} onClose={() => setSheet(null)} />
      ) : null}
      <UnitSwitcherSheet visible={sheet === 'unit'} onClose={() => setSheet(null)} />
      {sheet === 'filter' && filter ? (
        <FilterSheet
          title={FILTER_TITLE[filter]}
          allLabel={FILTER_ALL[filter]}
          options={options}
          value={pick?.id}
          onPick={(o) => setPicked((p) => ({ ...p, [filter]: o }))}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </Screen>
  );
}

/** The choices for the report's own filter chip. Ages come from the pending report's buckets. */
function useFilterOptions(filter: ReportFilterKey | null, report: Report | undefined): FilterOption[] {
  const customers = useParties({ type: 'customer' }, filter === 'customer');
  const brokers = useParties({ type: 'broker' }, filter === 'broker');
  const { data: plants } = usePlants();
  return useMemo(() => {
    switch (filter) {
      case 'customer':
        return (customers.data ?? []).map((p) => ({ id: p.id, label: p.name }));
      case 'broker':
        return (brokers.data ?? []).map((p) => ({ id: p.id, label: p.name }));
      case 'plant':
        return (plants ?? []).filter((p) => p.active).map((p) => ({ id: p.id, label: p.name }));
      case 'bucket':
        return report?.kind === 'pending-orders'
          ? report.summary.byBucket.map((b) => ({ id: b.bucket, label: `${b.bucket} days` }))
          : [];
      case null:
        return [];
    }
  }, [filter, customers.data, brokers.data, plants, report]);
}

/**
 * Board 23 `.flt` chip: icon and label, 44 dp tall. Without `onPress` it is a fixed label (pending
 * orders' "As of now", the unit of a report that covers every unit).
 */
function FilterChip({
  icon,
  label,
  name,
  hint,
  onPress,
}: {
  icon: IconName;
  label: string;
  /** What the chip sets, spoken before its value: "Date range, 1 – 17 Nov 2026". */
  name: string;
  hint?: string;
  onPress?: () => void;
}) {
  const { t } = useTheme();
  const content = (
    <>
      <Icon name={icon} size={16} color={onPress ? t.brt : t.tx3} />
      <Text variant="chip" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {label}
      </Text>
      {onPress ? <Icon name="chevronDown" size={14} color={t.tx3} /> : null}
    </>
  );
  const look = { backgroundColor: t.card, borderColor: t.bd2 };
  if (!onPress && !hint) {
    return (
      <View style={[styles.chip, look]} accessible accessibilityLabel={`${name}, ${label}`}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${label}`}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, look, pressed ? { backgroundColor: t.act } : null]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
